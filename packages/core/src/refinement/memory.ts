export * as RefinementMemory from "./memory"

import { Effect, Schema } from "effect"
import { Refinement } from "../refinement"
import { RefinementRunner } from "./runner"

export const Input = Schema.Struct({
  action: Schema.Literals(["list", "get", "apply", "history", "rollback", "refine", "status", "export"]),
  instructions: Schema.optional(Schema.String),
  scope: Schema.optional(Refinement.Scope),
  kind: Schema.optional(Refinement.Kind),
  id: Schema.optional(Schema.String),
  proposal: Schema.optional(Refinement.Proposal),
})

export const description = `Manage learned memories, reusable skill instructions, supplemental prompt notes, and subagent guidance.
Default scope is local to this session; use global only when explicitly requested by the user.
Use list/get to read entries, apply for evidence-backed create/update/delete edits, history to review changes, and rollback with a history id to undo a refinement.
Use refine to schedule a dedicated refinement after this provider response and its tools settle, before the next provider request (optional instructions focus the review). Use status to inspect pending/running work and the latest outcome, including the saved refinement id or failure. Use export with a skill id to write a standard SKILL.md into the global config directory's dedicated refine/skills directory (normally ~/.config/opencode/refine/skills). Scope selects the source ledger, not the export destination. Existing different files are never overwritten. Skill creates and updates automatically publish standard SKILL.md files shared across sessions, and skill deletion or rollback synchronizes those files. Discovery refreshes without restarting. Conflicting manually edited files are preserved and the operation fails.
Skills are repeatable procedures with a clear trigger and verification steps; subagent entries are delegation guidance, not new executable tools. Do not store secrets or speculative conclusions. Prefer updating an existing entry over duplicates. Current instructions always take precedence.`

export const execute = Effect.fn("RefinementMemory.execute")(function* (
  store: Refinement.Interface,
  runner: RefinementRunner.Interface,
  sessionID: string,
  input: typeof Input.Type,
) {
  const target = { sessionID, scope: input.scope ?? ("local" as const) }
  if (input.action === "status") return JSON.stringify(yield* runner.status(sessionID))
  if (input.action === "refine") {
    yield* runner.request(sessionID, { scope: target.scope, instructions: input.instructions })
    return "Refinement scheduled after this provider response and its tools settle. Use memory status to inspect the outcome."
  }
  if (input.action === "export") {
    if (!input.id) return yield* new Refinement.Error({ message: "export requires a skill id" })
    return yield* store.exportSkill(target, input.id)
  }
  if (input.action === "apply") {
    if (!input.proposal) return yield* new Refinement.Error({ message: "apply requires proposal" })
    const state = yield* store.apply(target, input.proposal)
    return JSON.stringify({
      entries: state.entries,
      refinement: input.proposal.edits.length ? state.history.at(-1) : undefined,
    })
  }
  if (input.action === "rollback") {
    if (!input.id) return yield* new Refinement.Error({ message: "rollback requires a refinement id" })
    return JSON.stringify((yield* store.rollback(target, input.id)).history.at(-1))
  }
  const state = yield* store.read(target)
  if (input.action === "history") return JSON.stringify(state.history.slice(-20))
  const entries = state.entries.filter((entry) => !input.kind || entry.kind === input.kind)
  if (input.action === "list")
    return JSON.stringify(
      entries.map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title, version: entry.version })),
    )
  if (!input.id || !input.kind) return yield* new Refinement.Error({ message: "get requires kind and id" })
  const entry = entries.find((entry) => entry.id === input.id)
  if (!entry) return yield* new Refinement.Error({ message: `Entry not found: ${input.kind}:${input.id}` })
  return JSON.stringify(entry)
})
