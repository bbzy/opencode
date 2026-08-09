import { Effect, Fiber, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export const loopConfig = {
  minIntervalMs: 30_000,
  maxConsecutiveFailures: 5,
  maxDryIterations: 3,
  // Provider returned nothing (no parts, zero output tokens) this many times
  // in a row — the provider is broken, not the task; stop instead of pausing.
  maxEmptyRounds: 2,
  // Proactively compact between rounds once the last round's token count
  // reaches this fraction of the usable context. Overflow-triggered
  // compaction fires only at the ceiling, where summarizing the whole
  // history no longer fits and fails — compacting earlier keeps that path
  // from ever running.
  compactionThreshold: 0.7,
  maxResults: 100,
}

export const FILE_MODIFY_TOOLS = new Set(["edit", "write", "apply_patch"])

// jj/git history or working-copy mutations never show up as
// edit/write/apply_patch parts; without counting them, legitimate repository
// tidying rounds (splitting an accidental file out of a commit, squashing,
// rewording) are misjudged as idle. Read-only subcommands (st/log/diff/
// status/bookmark list) deliberately don't match.
const VCS_MUTATION_PATTERN =
  /\b(?:jj|git)\s+(?:commit|split|squash|describe|abandon|rebase|new|merge|cherry-pick|revert|restore|reset|amend|undo|tag|bookmark\s+(?:move|create|delete|set|rename|track|untrack|forget))\b/

// Did the round produce durable progress? Counts completed file-modifying
// tool parts and completed bash parts that mutate VCS state, restricted to
// assistant messages newer than the round boundary.
export function roundMadeProgress(
  messages: readonly { info: { id: string; role: string }; parts: readonly SessionV1.Part[] }[],
  boundaryId: string | undefined,
) {
  return messages.some(
    (msg) =>
      msg.info.role === "assistant" &&
      (!boundaryId || msg.info.id > boundaryId) &&
      msg.parts.some((part) => {
        if (part.type !== "tool" || part.state?.status !== "completed") return false
        if (FILE_MODIFY_TOOLS.has(part.tool)) return true
        if (part.tool !== "bash") return false
        const command = (part.state.input as { command?: unknown } | undefined)?.command
        return typeof command === "string" && VCS_MUTATION_PATTERN.test(command)
      }),
  )
}

const CycleSchedule = Schema.Struct({
  type: Schema.Literal("cycle"),
  intervalMs: Schema.Number,
})

export const ScheduleInfo = CycleSchedule
export type ScheduleInfo = Schema.Schema.Type<typeof ScheduleInfo>

// In-memory only: cycle state lives and dies with the process. No
// persistence, no cross-process ownership, no recovery on restart.
export type LoopState = {
  intervalStr: string
  schedule: ScheduleInfo
  rounds: number
  startedAt: number
  nextRunAt: number
  paused: boolean
  pending: boolean
  running: boolean
  consecutiveFailures: number
  consecutiveDry: number
  consecutiveEmpty: number
  coalescedCount: number
  lastStatus?: "success" | "fail"
  timezone: string
  lastRoundResult?: { round: number; summary: string }
  fiber: Fiber.Fiber<void, unknown>
  trigger: (opts?: { queueWhenBusy?: boolean }) => Effect.Effect<void>
}

export function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
}

const durationUnitRegex = /^(?:\d+\s*(?:ms|s|m|h)\s*)+$/i
const durationPartRegex = /(\d+)\s*(ms|s|m|h)/gi
export function parseDuration(input: string): number | undefined {
  if (!durationUnitRegex.test(input)) return undefined
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
  const totalMs = [...input.matchAll(durationPartRegex)].reduce((sum, [, num, unit]) => {
    return sum + Number(num) * (multipliers[unit.toLowerCase()] ?? 0)
  }, 0)
  return totalMs > 0 ? totalMs : undefined
}

export function nextScheduledAt(schedule: ScheduleInfo, now: number) {
  return now + schedule.intervalMs
}

export function scheduleMode(): "cycle" {
  return "cycle"
}

// Cycle prompts omit "Next:" deliberately: the next round starts <interval>
// after this round *ends*, so any clock time shown here would be wrong for
// rounds longer than the interval.
export function buildCyclePrompt(
  round: number,
  context?: {
    consecutiveDry: number
    previous?: { round: number; summary: string }
    },
) {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const time = now.toTimeString().slice(0, 5)
  const lines = [`[Cycle #${round}] Automated cycle — iteration ${round}. ${date} ${time}.`]
  if (context?.previous) {
    lines.push(`Last completed iteration: #${context.previous.round} — ${context.previous.summary}`)
  }
  if (context && context.consecutiveDry > 0) {
    lines.push(
      `Idle status: ${context.consecutiveDry}/${loopConfig.maxDryIterations} consecutive iterations without file or VCS changes; the cycle auto-pauses at ${loopConfig.maxDryIterations}.`,
    )
  }
  lines.push(
    `If you already completed iteration ${round} or later, treat this as a duplicate delivery: confirm briefly without redoing work.`,
  )
  lines.push(
    `If no meaningful work remains, say DONE with a one-line reason instead of running status-check-only rounds.`,
  )
  return lines.join("\n")
}

export * as Loop from "./loop"
