import { Effect, Fiber, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export const loopConfig = {
  minIntervalMs: 30_000,
  maxConsecutiveFailures: 5,
  // Consecutive tool-free rounds before the scheduler challenges the agent
  // with the separate reflection skill.
  maxDryIterations: 3,
  // Tool-free rounds after the reflection round before pausing. The
  // reflection round itself is excluded from both inactivity sequences.
  maxPostReflectionDryIterations: 3,
  // Catch cross-round text loops.
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
}

// Observe tool activity without claiming that the round made real progress.
// The engine deliberately avoids classifying tool semantics so future tools
// work without Cycle integration.
export function roundUsedTool(
  messages: readonly { info: { id: string; role: string }; parts: readonly SessionV1.Part[] }[],
  boundaryId: string | undefined,
) {
  return messages
    .filter((msg) => msg.info.role === "assistant" && (!boundaryId || msg.info.id > boundaryId))
    .some((msg) => msg.parts.some((part) => part.type === "tool"))
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
  postReflection: boolean
  consecutiveDuplicateResponses: number
  consecutiveEmpty: number
  coalescedCount: number
  lastStatus?: "success" | "fail"
  timezone: string
  lastResponseFingerprint?: string
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

export function buildPostCompactionContext(
  todos: readonly { content: string; status: string; priority: string }[],
) {
  return [
    "The session context was compacted. Before continuing, load the cycle-on-project skill.",
    "The Cycle engine preserved this complete session todo snapshot:",
    JSON.stringify(todos, null, 2),
  ].join("\n")
}

// Cycle prompts omit "Next:" deliberately: the next round starts <interval>
// after this round *ends*, so any clock time shown here would be wrong for
// rounds longer than the interval.
export function buildCyclePrompt(
  round: number,
  context?: {
    consecutiveDry: number
    postReflection: boolean
  },
) {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const time = now.toTimeString().slice(0, 5)
  const lines = [
    `[Cycle #${round}] Automated cycle — iteration ${round}. ${date} ${time}.`,
    `Continue naturally from the visible session context. If the cycle-on-project owner contract is not already visible, load that skill now; otherwise do not reload it.`,
  ]
  if (context?.postReflection) {
    lines.push(
      `Post-reflection tool activity: ${context.consecutiveDry}/${loopConfig.maxPostReflectionDryIterations} consecutive completed rounds without a tool call. Any tool call returns the Cycle to normal operation; the Cycle will pause if this reaches ${loopConfig.maxPostReflectionDryIterations}.`,
    )
    return lines.join("\n")
  }
  if (context && context.consecutiveDry > 0) {
    lines.push(
      `Tool activity: ${context.consecutiveDry}/${loopConfig.maxDryIterations} consecutive completed rounds without a tool call before reflection.`,
    )
  }
  if (context && context.consecutiveDry >= loopConfig.maxDryIterations) {
    lines.push(
      `Reflection trigger: use the cycle-reflect skill now, loading it only if its body is not already visible in this session. This reflection round is excluded from tool-activity counting. After it ends, the Cycle will observe a fresh sequence of rounds; any tool call returns to normal operation, while ${loopConfig.maxPostReflectionDryIterations} consecutive tool-free rounds will pause the Cycle.`,
    )
  }
  return lines.join("\n")
}

export * as Loop from "./loop"
