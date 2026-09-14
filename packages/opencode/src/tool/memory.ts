import { Effect } from "effect"
import { define } from "./tool"
import { Refinement } from "@opencode-ai/core/refinement"
import { RefinementMemory } from "@opencode-ai/core/refinement/memory"
import { RefinementRunner } from "@opencode-ai/core/refinement/runner"
import { assertExternalDirectoryEffect } from "./external-directory"

export const MemoryTool = define<typeof RefinementMemory.Input, {}, Refinement.Service | RefinementRunner.Service>(
  "memory",
  Effect.gen(function* () {
    const store = yield* Refinement.Service
    const runner = yield* RefinementRunner.Service
    return {
      description: RefinementMemory.description,
      parameters: RefinementMemory.Input,
      execute: (input, ctx) =>
        Effect.gen(function* () {
          const resource =
            input.action === "export" && input.id ? store.exportPath(input.id) : `memory:${input.scope ?? "local"}:*`
          if (input.action === "export") yield* assertExternalDirectoryEffect(ctx, resource)
          yield* ctx.ask({
            permission: ["apply", "rollback", "refine", "export"].includes(input.action) ? "edit" : "read",
            patterns: [resource],
            always: [resource],
            metadata: { action: input.action },
          })
          return {
            title: `Memory ${input.action}`,
            output: yield* RefinementMemory.execute(store, runner, ctx.sessionID, input).pipe(Effect.orDie),
            metadata: {},
          }
        }),
    }
  }),
)
