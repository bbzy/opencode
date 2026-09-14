export * as MemoryTool from "./memory"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Refinement } from "../refinement"
import { RefinementMemory } from "../refinement/memory"
import { RefinementRunner } from "../refinement/runner"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const store = yield* Refinement.Service
    const runner = yield* RefinementRunner.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        memory: Tool.make({
          description: RefinementMemory.description,
          input: RefinementMemory.Input,
          output: Schema.String,
          toModelOutput: ({ output }) => [{ type: "text", text: output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const target =
                input.action === "export" && input.id
                  ? yield* mutation
                      .resolve({
                        path: store.exportPath(input.id),
                        kind: "file",
                      })
                      .pipe(Effect.orDie)
                  : undefined
              if (target?.externalDirectory)
                yield* permission
                  .assert({
                    ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                    sessionID: context.sessionID,
                    agent: context.agent,
                  })
                  .pipe(Effect.orDie)
              yield* permission
                .assert({
                  action: ["apply", "rollback", "refine", "export"].includes(input.action) ? "edit" : "read",
                  resources: [target?.resource ?? `memory:${input.scope ?? "local"}:*`],
                  save: [target?.resource ?? `memory:${input.scope ?? "local"}:*`],
                  sessionID: context.sessionID,
                  agent: context.agent,
                })
                .pipe(Effect.orDie)
              return yield* RefinementMemory.execute(store, runner, context.sessionID, input).pipe(
                Effect.mapError((error) => new Tool.Failure({ message: error.message })),
              )
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/memory",
  layer,
  deps: [ToolRegistry.node, Refinement.node, RefinementRunner.node, LocationMutation.node, PermissionV2.node],
})
