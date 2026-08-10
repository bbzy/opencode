import { Effect, Fiber, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export const loopConfig = {
  minIntervalMs: 30_000,
  maxConsecutiveFailures: 5,
  // Consecutive rounds without file or VCS changes before the scheduler
  // challenges the agent with the cycle skill's Reflect phase.
  maxDryIterations: 3,
  // Dry Plan rounds get a bounded opportunity to find higher-level work.
  // After this many additional dry rounds, pause for user redirection.
  maxPlanDryIterations: 3,
  // Require the model to independently confirm an exhausted/blocked verdict
  // before pausing, so one overly eager DONE cannot end unattended work.
  maxConsecutiveExhausted: 2,
  // Catch cross-round text loops that do not use the structured outcome.
  maxConsecutiveDuplicateResponses: 3,
  // Provider returned nothing (no parts, zero output tokens) this many times
  // in a row — the provider is broken, not the task; stop instead of pausing.
  maxEmptyRounds: 2,
  // Proactively compact between rounds once the last round's token count
  // reaches this fraction of the usable context. Overflow-triggered
  // compaction fires only at the ceiling, where summarizing the whole
  // history no longer fits and fails — compacting earlier keeps that path
  // from ever running.
  compactionThreshold: 0.7,
  // Maximum chars of the last assistant response to keep as the handoff
  // text when a session reset occurs.
  handoffMaxLength: 10_000,
}

export const FILE_MODIFY_TOOLS = new Set(["edit", "write", "apply_patch"])

// jj/git history or working-copy mutations never show up as
// edit/write/apply_patch parts; without counting them, legitimate repository
// tidying rounds (splitting an accidental file out of a commit, squashing,
// rewording) are misjudged as idle. Read-only subcommands (st/log/diff/
// status/bookmark list) deliberately don't match.
const VCS_MUTATION_PATTERN =
  /\b(?:jj|git)\s+(?:commit|split|squash|describe|abandon|rebase|new|merge|cherry-pick|revert|restore|reset|amend|undo|tag|bookmark\s+(?:move|create|delete|set|rename|track|untrack|forget))\b/

const VALIDATION_PATTERN =
  /(?:^|(?:&&|;|\|)\s*)(?:bun\s+(?:test|typecheck|run\s+(?:test|typecheck|lint|check|build))|npm\s+(?:test|run\s+(?:test|typecheck|lint|check|build))|pnpm\s+(?:test|run\s+(?:test|typecheck|lint|check|build))|yarn\s+(?:test|typecheck|lint|check|build)|cargo\s+(?:test|check|clippy|build)|go\s+test|pytest|ctest|cmake\s+--build|(?:\.\/)?gradlew?\s+[^;&|]*(?:test|check|lint|assemble|build)|make\s+(?:test|check|lint|build)|ninja(?:\s|$))/i

function completedCommand(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "bash" || part.state?.status !== "completed") return
  const command = (part.state.input as { command?: unknown } | undefined)?.command
  return typeof command === "string" ? command.trim().replace(/\s+/g, " ") : undefined
}

// Did the round produce new evidence or durable progress? A successful
// validation command counts once, but repeating the same green command in a
// later round does not let a cycle evade its dry budget indefinitely.
export function roundMadeProgress(
  messages: readonly { info: { id: string; role: string }; parts: readonly SessionV1.Part[] }[],
  boundaryId: string | undefined,
) {
  const previousValidations = new Set(
    messages
      .filter((msg) => msg.info.role === "assistant" && boundaryId && msg.info.id <= boundaryId)
      .flatMap((msg) => msg.parts)
      .map(completedCommand)
      .filter((command): command is string => !!command && VALIDATION_PATTERN.test(command)),
  )
  return messages.some(
    (msg) =>
      msg.info.role === "assistant" &&
      (!boundaryId || msg.info.id > boundaryId) &&
      msg.parts.some((part) => {
        if (part.type !== "tool" || part.state?.status !== "completed") return false
        if (FILE_MODIFY_TOOLS.has(part.tool)) return true
        if (part.tool !== "bash") return false
        const command = completedCommand(part)
        if (!command) return false
        if (VCS_MUTATION_PATTERN.test(command)) return true
        return VALIDATION_PATTERN.test(command) && !previousValidations.has(command)
      }),
  )
}

export type RoundOutcome = "exhausted" | "blocked"

export function roundOutcome(response: string): RoundOutcome | undefined {
  const marker = response
    .trim()
    .split("\n")
    .findLast((line) => line.trim())
    ?.trim()
    .match(/^CYCLE_OUTCOME:\s*(exhausted|blocked)$/i)?.[1]
  if (marker === "exhausted" || marker === "blocked") return marker
}

export function responseFingerprint(response: string) {
  return response
    .replace(/#\d+(?:-\d+)?/g, "#")
    .replace(/\b(?:iteration|round)\s+\d+\b/gi, "round #")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
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
  consecutiveExhausted: number
  consecutiveDuplicateResponses: number
  consecutiveEmpty: number
  coalescedCount: number
  lastStatus?: "success" | "fail"
  timezone: string
  resetInterval: number
  roundsSinceReset: number
  lastRoundResult?: { round: number; summary: string }
  lastResponseFingerprint?: string
  handoff?: string
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
    consecutiveExhausted?: number
    previous?: { round: number; summary: string }
    resetAfter?: boolean
    handoff?: string
    pendingTodos?: readonly string[]
  },
) {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const time = now.toTimeString().slice(0, 5)
  const lines = [`[Cycle #${round}] Automated cycle — iteration ${round}. ${date} ${time}.`]
  if (context?.handoff) {
    lines.push(
      `Session was reset after the previous iteration. Here is the handoff from the previous agent:`,
      context.handoff,
    )
  }
  if (context?.previous) {
    lines.push(`Last completed iteration: #${context.previous.round} — ${context.previous.summary}`)
  }
  if (context && context.consecutiveDry > 0) {
    lines.push(
      `Idle status: ${context.consecutiveDry}/${loopConfig.maxDryIterations} consecutive iterations without file or VCS changes before mandatory reflection.`,
    )
  }
  if (context && context.consecutiveDry === loopConfig.maxDryIterations) {
    lines.push(
      `Reflection challenge: load the cycle-on-project skill and perform its Reflect phase now. Do not rubber-stamp the previous work. Challenge its design, test coverage, process, commit organization, and the health of the wider scope. If any concern survives scrutiny, turn it into a concrete task and act on it. Proceed to Plan only if every dimension passes an honest review.`,
    )
  }
  if (context && context.consecutiveDry > loopConfig.maxDryIterations) {
    lines.push(
      `Planning escalation: the Reflect phase found no issue requiring rework. Load the cycle-on-project skill and perform its Plan phase now. Think as the responsible owner at a higher level, generate concrete in-scope candidates, choose the highest-value one yourself, and start it. Widen the frontier only when the user did not define a fixed scope.`,
    )
  }
  if (context?.consecutiveExhausted) {
    lines.push(
      `The previous ${context.consecutiveExhausted} iteration(s) reported an exhausted or externally blocked outcome. Audit that verdict independently. Resume work if a viable candidate exists; otherwise confirm the outcome again.`,
    )
  }
  if (context?.resetAfter) {
    lines.push(
      `⚠ This is the last iteration before a session reset. After you complete this iteration, the conversation history will be cleared to free context. Write a handoff summary for the next iteration's agent — describe the current state, what has been accomplished, and what remains to be done. The handoff will be included in the next iteration's prompt after the reset.`,
    )
  }
  if (context?.pendingTodos && context.pendingTodos.length > 0) {
    const todos = context.pendingTodos.slice(0, 10).map((content) => `"${content.slice(0, 120)}"`)
    lines.push(
      `Unfinished todos (${context.pendingTodos.length}): ${todos.join(", ")}. Resolve them or explicitly close them before declaring DONE.`,
    )
  }
  lines.push(
    `If you already completed iteration ${round} or later, treat this as a duplicate delivery: confirm briefly without redoing work.`,
  )
  lines.push(
    `If no meaningful work remains, say DONE with a one-line reason and end the response with exactly CYCLE_OUTCOME: exhausted.`,
  )
  lines.push(
    `Use CYCLE_OUTCOME: blocked instead when the only remaining work requires external input, authorization, or an unavailable environment. Emit neither marker while unfinished todos, unverified fixes, or viable candidates remain. Two confirmed outcome rounds pause the scheduler for user redirection.`,
  )
  return lines.join("\n")
}

export * as Loop from "./loop"
