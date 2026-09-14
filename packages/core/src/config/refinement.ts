export * as ConfigRefinement from "./refinement"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export const Info = Schema.Struct({
  auto: Schema.optional(Schema.Boolean).annotate({
    description: "Automatically review session lessons (default: true)",
  }),
  turn_interval: Schema.optional(PositiveInt).annotate({
    description: "Completed assistant turns between reviews (default: 25)",
  }),
  cooldown_ms: Schema.optional(NonNegativeInt).annotate({
    description: "Minimum time between automatic reviews (default: 1200000)",
  }),
  compact: Schema.optional(Schema.Boolean).annotate({
    description: "Review before context compaction (default: true)",
  }),
})
