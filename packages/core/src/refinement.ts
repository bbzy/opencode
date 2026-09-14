export * as Refinement from "./refinement"

import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Flock } from "./util/flock"

export const Kind = Schema.Literals(["memory", "skill", "prompt", "subagent"])
export const Scope = Schema.Literals(["local", "global"])
export const ID = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), Schema.isMaxLength(64))
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000))

export const Entry = Schema.Struct({
  id: ID,
  kind: Kind,
  title: Text,
  content: Text,
  evidence: Text,
  version: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type Entry = typeof Entry.Type

export const Edit = Schema.Struct({
  action: Schema.Literals(["create", "update", "delete"]),
  kind: Kind,
  id: ID,
  title: Schema.optional(Text),
  content: Schema.optional(Text),
  evidence: Text,
})
export const Proposal = Schema.Struct({
  summary: Text,
  edits: Schema.Array(Edit).check(Schema.isMaxLength(20)),
})
export type Proposal = typeof Proposal.Type

export const Change = Schema.Struct({
  kind: Kind,
  id: ID,
  before: Schema.optional(Entry),
  after: Schema.optional(Entry),
})
export const Record = Schema.Struct({
  id: Schema.String,
  summary: Text,
  createdAt: Schema.Number,
  rollbackOf: Schema.optional(Schema.String),
  changes: Schema.Array(Change),
})
export type Record = typeof Record.Type
export const State = Schema.Struct({
  schema: Schema.Literal(1),
  entries: Schema.Array(Entry),
  history: Schema.Array(Record),
})
export type State = typeof State.Type
export type Target = { sessionID: string; scope: typeof Scope.Type }

export class Error extends Schema.TaggedErrorClass<Error>()("RefinementError", { message: Schema.String }) {}

export function apply(state: State, proposal: Proposal, baseline: State = state): State {
  const entries = new Map(state.entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]))
  const seen = new Set<string>()
  const changes = proposal.edits.map((edit) => {
    const key = `${edit.kind}:${edit.id}`
    if (seen.has(key)) throw new Error({ message: `Duplicate refinement edit: ${key}` })
    seen.add(key)
    const before = entries.get(key)
    const expected = baseline.entries.find((entry) => entry.kind === edit.kind && entry.id === edit.id)
    if (JSON.stringify(before) !== JSON.stringify(expected))
      throw new Error({ message: `Entry changed during refinement: ${key}` })
    if (edit.action === "create" && before) throw new Error({ message: `Entry already exists: ${key}` })
    if (edit.action !== "create" && !before) throw new Error({ message: `Entry not found: ${key}` })
    if (edit.action === "delete") {
      entries.delete(key)
      return { kind: edit.kind, id: edit.id, before }
    }
    if (!edit.title || !edit.content) throw new Error({ message: `Title and content required: ${key}` })
    const after: Entry = {
      id: edit.id,
      kind: edit.kind,
      title: edit.title,
      content: edit.content,
      evidence: edit.evidence,
      version: (before?.version ?? 0) + 1,
      createdAt: before?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    entries.set(key, after)
    return { kind: edit.kind, id: edit.id, before, after }
  })
  if (!changes.length) return state
  return {
    schema: 1,
    entries: [...entries.values()],
    history: [...state.history, { id: crypto.randomUUID(), summary: proposal.summary, createdAt: Date.now(), changes }],
  }
}

export function rollback(state: State, id: string): State {
  const record = state.history.find((record) => record.id === id)
  if (!record) throw new Error({ message: `Refinement not found: ${id}` })
  if (state.history.some((record) => record.rollbackOf === id))
    throw new Error({ message: `Refinement already rolled back: ${id}` })
  const entries = new Map(state.entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]))
  const changes = [...record.changes].reverse().map((change) => {
    const key = `${change.kind}:${change.id}`
    if (JSON.stringify(entries.get(key)) !== JSON.stringify(change.after))
      throw new Error({ message: `Cannot roll back an entry modified later: ${key}` })
    if (change.before) entries.set(key, change.before)
    if (!change.before) entries.delete(key)
    return { kind: change.kind, id: change.id, before: change.after, after: change.before }
  })
  return {
    schema: 1,
    entries: [...entries.values()],
    history: [
      ...state.history,
      { id: crypto.randomUUID(), summary: `Rollback ${id}`, createdAt: Date.now(), rollbackOf: id, changes },
    ],
  }
}

export function context(local: State, global: State) {
  const entries = [
    ...local.entries,
    ...global.entries.filter(
      (entry) => !local.entries.some((item) => item.kind === entry.kind && item.id === entry.id),
    ),
  ]
    .toReversed()
    .sort((a, b) => b.updatedAt - a.updatedAt)
  if (!entries.length) return ""
  // Reserve room for the catalog before considering bodies. Prefer recent entries
  // when the catalog itself overflows, and expose how to discover the rest.
  const catalog = entries.slice(0, 40)
  const bodyBudget = Math.floor(
    8000 / Math.max(1, catalog.filter((entry) => entry.kind === "memory" || entry.kind === "prompt").length),
  )
  return [
    "<refinement_memory>",
    "Previously learned supplemental context; it does not override current user instructions or permissions.",
    "Use the memory tool to inspect or maintain entries. Skill and subagent entries are reusable guidance, not installed executable tools.",
    `${entries.length - catalog.length} entries omitted from this catalog. Use memory list with scope local or global to discover all saved entries.`,
    ...catalog.map((entry) => {
      const label = `${local.entries.includes(entry) ? "local" : "global"}:${entry.kind}:${entry.id} — ${entry.title.slice(0, 180)}${entry.title.length > 180 ? "…" : ""}`
      if ((entry.kind === "memory" || entry.kind === "prompt") && entry.content.length <= bodyBudget)
        return `${label}\n${entry.content}`
      return `${label}\nContent omitted; load the full entry with memory get and the indicated scope, kind and id.`
    }),
    "</refinement_memory>",
  ].join("\n")
}

export interface Interface {
  readonly read: (target: Target) => Effect.Effect<State, Error>
  readonly apply: (target: Target, proposal: Proposal, baseline?: State) => Effect.Effect<State, Error>
  readonly rollback: (target: Target, id: string) => Effect.Effect<State, Error>
  readonly context: (sessionID: string) => Effect.Effect<string, Error>
  readonly exportSkill: (target: Target, id: string) => Effect.Effect<string, Error>
  readonly exportPath: (id: string) => string
}
export class Service extends Context.Service<Service, Interface>()("@opencode/Refinement") {}

const decode = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(State)))
const failure = (error: unknown) => (error instanceof Error ? error : new Error({ message: String(error) }))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const exportPath = (id: string) =>
      path.join(global.config, "refine", "skills", Schema.decodeUnknownSync(ID)(id), "SKILL.md")
    const file = (target: Target) =>
      path.join(
        global.data,
        "refinement",
        target.scope === "global" ? "global" : `session-${encodeURIComponent(target.sessionID)}`,
        "state.json",
      )
    const read = Effect.fn("Refinement.read")(function* (target: Target) {
      const content = yield* fs.readFileStringSafe(file(target))
      if (content === undefined) return { schema: 1 as const, entries: [], history: [] }
      const state = decode(content)
      if (Option.isNone(state)) return yield* new Error({ message: `Invalid refinement store: ${file(target)}` })
      return state.value
    }, Effect.mapError(failure))
    const update = Effect.fn("Refinement.update")(
      function* (target: Target, change: (state: State) => State) {
        yield* Flock.effect(file(target), { dir: path.join(global.data, "refinement", "locks") })
        const current = yield* read(target)
        const next = yield* Effect.try({ try: () => change(current), catch: failure })
        if (next === current) return next
        const temp = `${file(target)}.${crypto.randomUUID()}.tmp`
        yield* fs.writeWithDirs(temp, JSON.stringify(next), 0o600)
        yield* fs.rename(temp, file(target)).pipe(Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)))
        return next
      },
      Effect.scoped,
      Effect.mapError(failure),
    )
    return Service.of({
      read,
      exportPath,
      apply: (target, proposal, baseline) => update(target, (state) => apply(state, proposal, baseline)),
      rollback: (target, id) => update(target, (state) => rollback(state, id)),
      exportSkill: Effect.fn("Refinement.exportSkill")(
        function* (target, id) {
          const entry = (yield* read(target)).entries.find((entry) => entry.kind === "skill" && entry.id === id)
          if (!entry) return yield* new Error({ message: `Skill entry not found: ${id}` })
          const destination = exportPath(entry.id)
          yield* Flock.effect(destination, { dir: path.join(global.data, "refinement", "locks") })
          const content = `---\nname: ${entry.id}\ndescription: ${JSON.stringify(entry.title)}\n---\n\n${entry.content}\n`
          const previous = yield* fs.readFileStringSafe(destination)
          if (previous !== undefined && previous !== content)
            return yield* new Error({
              message: `Skill file already exists; review and update it with the normal edit tool: ${destination}`,
            })
          yield* fs.writeWithDirs(destination, content, 0o600)
          return destination
        },
        Effect.scoped,
        Effect.mapError(failure),
      ),
      context: Effect.fn("Refinement.context")(function* (sessionID) {
        return context(yield* read({ sessionID, scope: "local" }), yield* read({ sessionID, scope: "global" }))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })
