export * as LoopEvent from "./loop-event"

import { Effect, Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { SessionID } from "./session-id"
import { NonNegativeInt } from "./schema"

export const LoopState = Schema.Struct({
  // Decode-only defaults keep version-skewed peers (old servers without these
  // fields) decodable without making the fields optional on encode.
  mode: Schema.Literal("cycle").pipe(Schema.withDecodingDefaultKey(Effect.succeed("cycle" as const))),
  intervalStr: Schema.String,
  model: optional(Schema.String),
  rounds: NonNegativeInt,
  successfulRounds: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  failedRounds: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  interruptedRounds: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  startedAt: Schema.Number,
  nextRunAt: Schema.Number,
  paused: Schema.Boolean,
  pending: Schema.Boolean,
  running: Schema.Boolean,
  consecutiveFailures: NonNegativeInt,
  consecutiveDry: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  coalescedCount: NonNegativeInt,
  lastStatus: optional(Schema.Literals(["success", "fail"])),
  lastError: optional(Schema.String),
  pauseReason: optional(Schema.String),
}).annotate({ identifier: "LoopState" })
export type LoopState = Schema.Schema.Type<typeof LoopState>

export const Updated = Event.define({
  type: "session.loop.updated",
  schema: {
    sessionID: SessionID,
    state: optional(LoopState),
  },
})

export const Definitions = Event.inventory(Updated)
