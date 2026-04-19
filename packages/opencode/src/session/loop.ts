import { Effect, Fiber, Option, Schema } from "effect"
import type { Storage } from "@/storage/storage"

export const loopConfig = {
  minIntervalMs: 30_000,
  maxConsecutiveFailures: 5,
  maxDryIterations: 3,
  maxResults: 100,
}

const CycleSchedule = Schema.Struct({
  type: Schema.Literal("cycle"),
  intervalMs: Schema.Number,
})

export const ScheduleInfo = CycleSchedule
export type ScheduleInfo = Schema.Schema.Type<typeof ScheduleInfo>

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
  coalescedCount: Schema.Number,
  lastStatus: Schema.optional(Schema.Literals(["success", "fail"])),
  timezone: Schema.String,
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
    coalescedCount: state.coalescedCount,
    lastStatus: state.lastStatus,
    timezone: state.timezone,
  }
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
export function buildCyclePrompt(round: number) {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const time = now.toTimeString().slice(0, 5)
  return `[Cycle #${round}] Automated cycle — iteration ${round}. ${date} ${time}.`
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

export * as Loop from "./loop"
