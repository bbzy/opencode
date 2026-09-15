export * as DirectoryGrant from "./directory"

import { and, eq, or } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { DirectoryGrant } from "@opencode-ai/schema/directory-grant"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { DirectoryGrantTable } from "./directory.sql"

export { Info, Scope } from "@opencode-ai/schema/directory-grant"
export type Target = { sessionID: string; projectID: string }

export interface Interface {
  readonly list: (target: Target) => Effect.Effect<DirectoryGrant.Info[]>
  readonly add: (target: Target, scope: DirectoryGrant.Scope, patterns: readonly string[]) => Effect.Effect<void>
  readonly remove: (target: Target, id: string) => Effect.Effect<void>
  readonly listen: (listener: () => Effect.Effect<void>) => Effect.Effect<Effect.Effect<void>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DirectoryGrant") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const listeners = new Set<() => Effect.Effect<void>>()
    const applicable = (target: Target) =>
      or(
        and(eq(DirectoryGrantTable.scope, "global"), eq(DirectoryGrantTable.owner, "")),
        and(eq(DirectoryGrantTable.scope, "project"), eq(DirectoryGrantTable.owner, target.projectID)),
        and(eq(DirectoryGrantTable.scope, "session"), eq(DirectoryGrantTable.owner, target.sessionID)),
      )
    const list = (target: Target) =>
      database.db.select().from(DirectoryGrantTable).where(applicable(target)).all().pipe(Effect.orDie)
    const notify = () =>
      Effect.forEach(
        listeners,
        (listener) =>
          listener().pipe(
            Effect.catchCause((cause) => Effect.logError("Failed to reconcile directory grants", { cause })),
          ),
        { discard: true },
      )
    return Service.of({
      list,
      add: Effect.fn("DirectoryGrant.add")(function* (target, scope, patterns) {
        if (!patterns.length) return
        yield* database.db
          .insert(DirectoryGrantTable)
          .values(
            patterns.map((pattern) => ({
              id: crypto.randomUUID(),
              scope,
              owner: scope === "global" ? "" : scope === "project" ? target.projectID : target.sessionID,
              pattern,
            })),
          )
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* notify()
      }),
      remove: Effect.fn("DirectoryGrant.remove")(function* (target, id) {
        yield* database.db
          .delete(DirectoryGrantTable)
          .where(and(eq(DirectoryGrantTable.id, id), applicable(target)))
          .run()
          .pipe(Effect.orDie)
        yield* notify()
      }),
      listen: (listener) =>
        Effect.sync(() => {
          listeners.add(listener)
          return Effect.sync(() => {
            listeners.delete(listener)
          })
        }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
