import { Effect, Fiber, Option, Schema } from "effect"
import type { Storage } from "@/storage/storage"
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

export const LoopOwner = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
})
export type LoopOwner = Schema.Schema.Type<typeof LoopOwner>

export const SerializedLoopState = Schema.Struct({
  version: Schema.Literal(1),
  intervalStr: Schema.String,
  schedule: ScheduleInfo,
  rounds: Schema.Number,
  startedAt: Schema.Number,
  nextRunAt: Schema.Number,
  paused: Schema.Boolean,
  pending: Schema.Boolean,
  running: Schema.Boolean,
  consecutiveFailures: Schema.Number,
  // Decode-only default so loop states persisted before this field existed
  // still recover instead of being discarded as invalid.
  consecutiveDry: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  // Decode-only default so loop states persisted before this field existed
  // still recover.
  consecutiveEmpty: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  coalescedCount: Schema.Number,
  lastStatus: Schema.optional(Schema.Literals(["success", "fail"])),
  timezone: Schema.String,
  // Cross-process single ownership: the owning process renews this lease at
  // every tick; other processes leave the loop alone while the lease is fresh.
  owner: Schema.optional(LoopOwner),
  // Bumped by pause/resume commands so schedulers in other processes can tell
  // command mutations apart from their own last persist.
  commandSeq: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
})
export type SerializedLoopState = Schema.Schema.Type<typeof SerializedLoopState>

export type LoopState = {
  -readonly [Key in keyof SerializedLoopState]: SerializedLoopState[Key]
} & {
  fiber: Fiber.Fiber<void, unknown>
  trigger: (opts?: { queueWhenBusy?: boolean }) => Effect.Effect<void>
}

export function serializeLoopState(state: LoopState): SerializedLoopState {
  return {
    version: 1,
    intervalStr: state.intervalStr,
    schedule: state.schedule,
    rounds: state.rounds,
    startedAt: state.startedAt,
    nextRunAt: state.nextRunAt,
    paused: state.paused,
    pending: state.pending,
    running: state.running,
    consecutiveFailures: state.consecutiveFailures,
    consecutiveDry: state.consecutiveDry,
    consecutiveEmpty: state.consecutiveEmpty,
    coalescedCount: state.coalescedCount,
    lastStatus: state.lastStatus,
    timezone: state.timezone,
    owner: state.owner,
    commandSeq: state.commandSeq,
  }
}

// How long an ownership lease stays fresh without renewal. The owner renews
// once per interval, so two intervals of silence (with a floor for very short
// intervals) means the owning process is gone.
export function ownerLeaseMs(intervalMs: number) {
  return Math.max(2 * intervalMs, 120_000)
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
  lines.push(`If no meaningful work remains, say DONE with a one-line reason instead of running status-check-only rounds.`)
  return lines.join("\n")
}

function stateKey(sessionID: string) {
  return ["loop", sessionID, "state"]
}

function roundsKey(sessionID: string) {
  return ["loop", sessionID, "round"]
}

export function persistLoopState(storage: Storage.Interface, sessionID: string, state: SerializedLoopState) {
  return storage.write(stateKey(sessionID), state).pipe(Effect.ignore)
}

export function readPersistedState(storage: Storage.Interface, sessionID: string) {
  return Effect.gen(function* () {
    const data = yield* storage.read<unknown>(stateKey(sessionID)).pipe(
      Effect.map((value) => ({ type: "found" as const, value })),
      Effect.catchTag("NotFoundError", () => Effect.succeed({ type: "missing" as const })),
      Effect.catch(() => Effect.succeed({ type: "invalid" as const })),
    )
    if (data.type !== "found") return data
    const decoded = Schema.decodeUnknownOption(SerializedLoopState)(data.value)
    if (Option.isNone(decoded)) return { type: "invalid" as const }
    return { type: "found" as const, state: decoded.value }
  })
}

export function clearPersistedState(storage: Storage.Interface, sessionID: string) {
  return storage.remove(stateKey(sessionID)).pipe(Effect.ignore)
}

export function persistRoundResult(
  storage: Storage.Interface,
  sessionID: string,
  round: number,
  data: { timestamp: number; prompt: string; status: string; response: string },
) {
  return Effect.gen(function* () {
    const prefix = roundsKey(sessionID)
    yield* storage.write([...prefix, String(round).padStart(9, "0")], { round, ...data }).pipe(Effect.ignore)
    const entries = yield* storage.list(prefix).pipe(Effect.orElseSucceed(() => []))
    yield* Effect.forEach(entries.slice(0, -loopConfig.maxResults), (key) => storage.remove(key).pipe(Effect.ignore), {
      discard: true,
    })
  })
}

// The previous round's response tail, folded into the next round prompt so
// the model has cross-round continuity without re-deriving what just happened.
export function latestRoundResult(storage: Storage.Interface, sessionID: string) {
  return Effect.gen(function* () {
    const entries = yield* storage.list(roundsKey(sessionID)).pipe(Effect.orElseSucceed(() => []))
    const last = entries.at(-1)
    if (!last) return undefined
    const data = yield* storage.read<{ round: number; response?: string }>(last).pipe(Effect.orElseSucceed(() => undefined))
    if (!data || typeof data.response !== "string" || data.response.trim() === "") return undefined
    const summary = data.response.replace(/\s+/g, " ").trim().slice(-300)
    return { round: data.round, summary }
  })
}

export * as Loop from "./loop"
