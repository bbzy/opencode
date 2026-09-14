export * as RefinementContext from "./context"

import { Effect, Schema } from "effect"
import { Refinement } from "../refinement"
import { SystemContext } from "../system-context/index"

export const load = Effect.fn("RefinementContext.load")(function* (store: Refinement.Interface, sessionID: string) {
  const content = yield* store
    .context(sessionID)
    .pipe(Effect.catch((error) => Effect.logWarning(error.message).pipe(Effect.as(""))))
  if (!content) return SystemContext.empty
  return SystemContext.make({
    key: SystemContext.Key.make("core/refinement"),
    codec: Schema.toCodecJson(Schema.String),
    load: Effect.succeed(content),
    baseline: (content) => content,
    update: (_previous, content) => content || "Previously supplied refinement memory has been removed.",
    removed: () => "Previously supplied refinement memory has been removed.",
  })
})
