import { afterAll, describe, expect, test } from "bun:test"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"
import { Refinement } from "@opencode-ai/core/refinement"
import { RefinementRunner } from "@opencode-ai/core/refinement/runner"
import { RefinementMemory } from "@opencode-ai/core/refinement/memory"
import { SkillV2 } from "@opencode-ai/core/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const directory = await tmpdir()
afterAll(() => directory[Symbol.asyncDispose]())
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([RefinementRunner.node, Refinement.node, SkillV2.node]), [
    [Global.node, Global.layerWith({ data: directory.path, config: path.join(directory.path, "config") })],
  ]),
)
const empty: Refinement.State = { schema: 1, entries: [], history: [] }
const proposal: Refinement.Proposal = {
  summary: "Remember the validated package test command",
  edits: [
    {
      action: "create",
      kind: "memory",
      id: "package-tests",
      title: "Run tests from package directories",
      content: "The root test guard rejects test execution. Change to the package directory first.",
      evidence: "Root test invocation failed; package invocation succeeded.",
    },
  ],
}

describe("Refinement ledger", () => {
  it.live("publishes skills across sessions and refreshes discovery on update and rollback", () =>
    Effect.gen(function* () {
      const store = yield* Refinement.Service
      const skills = yield* SkillV2.Service
      const target = { sessionID: "publisher", scope: "local" as const }
      const edit = { ...proposal.edits[0]!, kind: "skill" as const, id: "published-skill" }
      yield* skills.transform((draft) =>
        draft.source({
          type: "directory",
          path: AbsolutePath.make(path.dirname(path.dirname(store.exportPath(edit.id)))),
        }),
      )
      expect(yield* skills.list()).toEqual([])
      const created = yield* store.apply(target, { ...proposal, edits: [edit] })
      expect((yield* skills.list()).find((entry) => entry.name === edit.id)?.content.trim()).toBe(edit.content!)
      expect((yield* store.read({ ...target, sessionID: "new-session" })).entries).toEqual([])
      const updated = yield* store.apply(target, {
        ...proposal,
        edits: [{ ...edit, action: "update", content: "Updated procedure" }],
      })
      expect((yield* skills.list()).find((entry) => entry.name === edit.id)?.content.trim()).toBe("Updated procedure")
      yield* store.rollback(target, updated.history.at(-1)!.id)
      expect((yield* skills.list()).find((entry) => entry.name === edit.id)?.content.trim()).toBe(edit.content!)
      yield* Effect.promise(() => Bun.write(store.exportPath(edit.id), "Manual edit"))
      expect(Exit.isFailure(yield* store.rollback(target, created.history[0]!.id).pipe(Effect.exit))).toBe(true)
      expect((yield* store.read(target)).entries).toHaveLength(1)
      yield* Effect.promise(() =>
        Bun.write(
          store.exportPath(edit.id),
          `---\nname: ${edit.id}\ndescription: ${JSON.stringify(edit.title)}\n---\n\n${edit.content}\n`,
        ),
      )
      yield* store.rollback(target, created.history[0]!.id)
      expect((yield* skills.list()).find((entry) => entry.name === edit.id)).toBeUndefined()
    }),
  )

  test("large memories cannot hide later entries or truncate the context wrapper", () => {
    const state = Refinement.apply(empty, {
      summary: "Context budget",
      edits: [
        { ...proposal.edits[0]!, id: "first", content: "a".repeat(16000) },
        { ...proposal.edits[0]!, id: "second", content: "b".repeat(16000) },
        { ...proposal.edits[0]!, id: "new-lesson", content: "Run package tests." },
      ],
    })
    const context = Refinement.context(state, empty)
    expect(context).toContain("local:memory:first")
    expect(context).toContain("local:memory:second")
    expect(context).toContain("local:memory:new-lesson")
    expect(context).toContain("Run package tests.")
    expect(context).toContain("Content omitted; load the full entry")
    expect(context.endsWith("</refinement_memory>")).toBe(true)
    expect(context.length).toBeLessThanOrEqual(24000)
  })

  test("catalog overflow favors recent entries and keeps local overrides and discovery instructions", () => {
    const entry = Refinement.apply(empty, proposal).entries[0]!
    const global: Refinement.State = {
      ...empty,
      entries: Array.from({ length: 100 }, (_, i) => ({
        ...entry,
        id: `memory-${i}`,
        title: "t".repeat(16000),
        content: "c".repeat(16000),
        updatedAt: i,
      })),
    }
    const local: Refinement.State = {
      ...empty,
      entries: [{ ...entry, id: "memory-99", content: "Local override", updatedAt: 100 }],
    }
    const context = Refinement.context(local, global)
    expect(context).toContain("60 entries omitted")
    expect(context).toContain("memory list with scope local or global")
    expect(context).toContain("local:memory:memory-99")
    expect(context).not.toContain("global:memory:memory-99")
    expect(context).toContain("Local override")
    expect(context).toContain("global:memory:memory-98")
    expect(context.length).toBeLessThanOrEqual(24000)
    expect(context.endsWith("</refinement_memory>")).toBe(true)
  })
  test("create/update/delete and rollback restore exact snapshots", () => {
    const created = Refinement.apply(empty, proposal)
    const updated = Refinement.apply(created, {
      summary: "Clarify",
      edits: [{ ...proposal.edits[0]!, action: "update", content: "Run bun test in the affected package." }],
    })
    expect(updated.entries[0]?.version).toBe(2)
    expect(Refinement.rollback(updated, updated.history.at(-1)!.id).entries).toEqual(created.entries)
    const deleted = Refinement.apply(created, {
      summary: "Remove",
      edits: [{ action: "delete", kind: "memory", id: "package-tests", evidence: "Superseded" }],
    })
    expect(deleted.entries).toEqual([])
    expect(Refinement.rollback(deleted, deleted.history.at(-1)!.id).entries).toEqual(created.entries)
    expect(Refinement.rollback(created, created.history[0]!.id).entries).toEqual([])
    expect(empty.entries).toEqual([])
  })

  test("rejects stale plans, duplicate edits, and rollback over later changes", () => {
    const created = Refinement.apply(empty, proposal)
    const update = {
      summary: "Clarify",
      edits: [{ ...proposal.edits[0]!, action: "update" as const, content: "New content" }],
    }
    expect(() => Refinement.apply(created, proposal, empty)).toThrow("changed during refinement")
    expect(() => Refinement.apply(empty, { ...proposal, edits: [...proposal.edits, ...proposal.edits] })).toThrow(
      "Duplicate",
    )
    const updated = Refinement.apply(created, update)
    expect(() => Refinement.rollback(updated, created.history[0]!.id)).toThrow("modified later")
    const rolled = Refinement.rollback(created, created.history[0]!.id)
    expect(() => Refinement.rollback(rolled, created.history[0]!.id)).toThrow("already rolled back")
    expect(created.entries[0]?.content).toEqual(proposal.edits[0]!.content!)
  })

  test("rejects malformed proposals and path traversal identifiers", () => {
    expect(() => RefinementRunner.parse(Refinement.Proposal, '{"summary":"truncated"')).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Refinement.Proposal)({
        ...proposal,
        edits: [{ ...proposal.edits[0], id: "../escape" }],
      }),
    ).toThrow()
    expect(RefinementRunner.parse(Refinement.Proposal, `\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``)).toEqual(
      proposal,
    )
  })

  it.live("persists isolated scopes, exports skills, and refuses overwrites", () =>
    Effect.gen(function* () {
      const store = yield* Refinement.Service
      const target = { sessionID: "isolation", scope: "local" as const }
      yield* store.apply(target, proposal)
      expect((yield* store.read(target)).entries).toHaveLength(1)
      expect((yield* store.read({ ...target, sessionID: "other" })).entries).toEqual([])
      expect((yield* store.read({ ...target, scope: "global" })).entries).toEqual([])
      yield* store.apply(target, { ...proposal, edits: [{ ...proposal.edits[0]!, kind: "skill" }] })
      expect(yield* Effect.promise(() => Bun.file(store.exportPath("package-tests")).exists())).toBe(true)
      const exported = yield* store.exportSkill(target, "package-tests")
      expect(exported).toBe(path.join(directory.path, "config", "refine", "skills", "package-tests", "SKILL.md"))
      yield* store.apply(
        { ...target, scope: "global" },
        { ...proposal, edits: [{ ...proposal.edits[0]!, kind: "skill" }] },
      )
      expect(yield* store.exportSkill({ ...target, scope: "global" }, "package-tests")).toBe(exported)
      expect(ConfigMarkdown.parseOption(yield* Effect.promise(() => Bun.file(exported).text()))?.data).toEqual({
        name: "package-tests",
        description: "Run tests from package directories",
      })
      yield* Effect.promise(() => Bun.write(exported, "user-authored skill"))
      expect(Exit.isFailure(yield* store.exportSkill(target, "package-tests").pipe(Effect.exit))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(exported).text())).toBe("user-authored skill")
    }),
  )

  it.live("serializes concurrent writes without losing unrelated entries", () =>
    Effect.gen(function* () {
      const store = yield* Refinement.Service
      const target = { sessionID: "concurrent", scope: "local" as const }
      yield* Effect.all(
        ["first", "second", "third"].map((id) =>
          store.apply(target, { ...proposal, edits: [{ ...proposal.edits[0]!, id }] }, empty),
        ),
        { concurrency: "unbounded" },
      )
      expect((yield* store.read(target)).entries.map((entry) => entry.id).sort()).toEqual(["first", "second", "third"])
    }),
  )
})

describe("Refinement checkpoints", () => {
  it.live("cancelling pending refinement prevents it from leaking into the next task", () =>
    Effect.gen(function* () {
      const runner = yield* RefinementRunner.Service
      yield* runner.request("cancel-pending", { scope: "global" })
      yield* runner.cancelPending("cancel-pending")
      expect(yield* runner.status("cancel-pending")).toMatchObject({
        pending: false,
        outcome: { status: "cancelled", scope: "global" },
      })
      yield* runner.checkpoint({
        sessionID: "cancel-pending",
        turnID: "next-task",
        config: { auto: false },
        trajectory: "Unrelated work",
        complete: () => Effect.die("Cancelled request must not run"),
      })
      yield* runner.request("cancel-pending", { scope: "local" })
      expect(
        yield* runner.checkpoint({
          sessionID: "cancel-pending",
          turnID: "new-request",
          config: { auto: false },
          trajectory: "New evidence",
          complete: () => Effect.succeed(JSON.stringify(proposal)),
        }),
      ).toBeDefined()
      yield* runner.cancelPending("cancel-pending")
      expect((yield* runner.status("cancel-pending")).outcome?.status).toBe("completed")
    }),
  )
  test("bounds serialized evidence without truncating editable entries", () => {
    const state = Refinement.apply(empty, proposal)
    const large: Refinement.State = {
      ...state,
      entries: Array.from({ length: 300 }, (_, index) => ({
        ...state.entries[0]!,
        id: `entry-${index}`,
        content: "\u0000".repeat(16000),
      })),
      history: Array.from({ length: 100 }, () => ({ ...state.history[0]!, summary: "long history".repeat(1000) })),
    }
    const text = RefinementRunner.evidence(
      {
        scope: "local",
        instructions: "\u0000".repeat(100000),
        trajectory: "\u0000".repeat(100000) + "latest evidence",
      },
      large,
      large,
    )
    expect(text.length).toBeLessThan(96000)
    const result = JSON.parse(text)
    expect(result.omittedEntries).toBe(300)
    expect(result.entries).toEqual([])
    expect(result.trajectory.endsWith("latest evidence")).toBe(true)
    expect(
      JSON.parse(RefinementRunner.evidence({ scope: "local", trajectory: "lesson" }, state, empty)).entries,
    ).toEqual(state.entries)
  })

  it.live("automatic ask/deny never infer; authorized requests may use ask but cannot bypass deny", () =>
    Effect.gen(function* () {
      const runner = yield* RefinementRunner.Service
      const calls: string[] = []
      const input = {
        sessionID: "permission",
        turnID: "one",
        compact: true,
        trajectory: "lesson",
        complete: () =>
          Effect.sync(() => {
            calls.push("proposal")
            return JSON.stringify(proposal)
          }),
      }
      yield* runner.checkpoint({ ...input, permission: () => "ask" })
      yield* runner.checkpoint({ ...input, permission: () => "deny" })
      expect(calls).toEqual([])
      yield* runner.request(input.sessionID, {})
      expect(yield* runner.checkpoint({ ...input, permission: () => "ask" })).toMatchObject({
        summary: proposal.summary,
      })
      yield* runner.request(input.sessionID, { scope: "global" })
      expect(
        Exit.isFailure(
          yield* runner
            .checkpoint({ ...input, permission: (scope) => (scope === "global" ? "deny" : "allow") })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(calls).toHaveLength(1)
      expect((yield* runner.status(input.sessionID)).outcome).toMatchObject({ status: "failed", scope: "global" })
    }),
  )

  it.live("queued outcomes are observable and notification failures preserve committed results", () =>
    Effect.gen(function* () {
      const runner = yield* RefinementRunner.Service
      const outcomes: RefinementRunner.Outcome[] = []
      const input = {
        sessionID: "outcomes",
        turnID: "one",
        trajectory: "lesson",
        config: { auto: false },
        notify: (outcome: RefinementRunner.Outcome) =>
          Effect.sync(() => {
            outcomes.push(outcome)
          }),
      }
      yield* runner.request(input.sessionID, {})
      const record = yield* runner.checkpoint({ ...input, complete: () => Effect.succeed(JSON.stringify(proposal)) })
      expect(outcomes[0]).toMatchObject({ status: "completed", id: record!.id })
      yield* runner.request(input.sessionID, {})
      yield* runner.checkpoint({ ...input, complete: () => Effect.succeed('{"summary":"nothing new","edits":[]}') })
      expect(outcomes[1]?.status).toBe("unchanged")
      yield* runner.request(input.sessionID, {})
      yield* runner.checkpoint({ ...input, complete: () => Effect.succeed("invalid JSON") }).pipe(Effect.exit)
      expect(outcomes[2]?.status).toBe("failed")
      expect(yield* runner.status(input.sessionID)).toMatchObject({
        pending: false,
        running: false,
        outcome: outcomes[2],
      })
      yield* runner.request(input.sessionID, {})
      const saved = yield* runner.checkpoint({
        ...input,
        complete: () =>
          Effect.succeed(JSON.stringify({ ...proposal, edits: [{ ...proposal.edits[0], action: "update" }] })),
        notify: () => Effect.die("UI disconnected"),
      })
      expect((yield* runner.status(input.sessionID)).outcome).toMatchObject({ status: "completed", id: saved!.id })
    }),
  )

  it.live("reviews once per eligible turn and observes the cooldown", () =>
    Effect.gen(function* () {
      const runner = yield* RefinementRunner.Service
      const calls: string[] = []
      const input = {
        sessionID: "interval",
        turnID: "one",
        trajectory: "Verified test procedure",
        config: { turn_interval: 2, cooldown_ms: 999999 },
        complete: (system: string) =>
          Effect.sync(() => {
            calls.push(system)
            return system.startsWith("Review")
              ? '{"shouldRefine":true,"rationale":"Verified"}'
              : JSON.stringify(proposal)
          }),
      }
      yield* runner.checkpoint(input)
      yield* runner.checkpoint(input)
      expect(calls).toHaveLength(0)
      expect(yield* runner.checkpoint({ ...input, turnID: "two" })).toMatchObject({ summary: proposal.summary })
      expect(calls).toHaveLength(2)
      yield* runner.checkpoint({ ...input, turnID: "three", compact: true })
      expect(calls).toHaveLength(2)
    }),
  )

  it.live("auto off and child sessions skip inference; a manual request still runs", () =>
    Effect.gen(function* () {
      const runner = yield* RefinementRunner.Service
      const calls: string[] = []
      const input = {
        sessionID: "manual",
        turnID: "one",
        child: true,
        compact: true,
        trajectory: "Verified lesson",
        config: { auto: false },
        complete: (system: string) =>
          Effect.sync(() => {
            calls.push(system)
            return JSON.stringify(proposal)
          }),
      }
      yield* runner.checkpoint(input)
      expect(calls).toEqual([])
      yield* runner.request(input.sessionID, { instructions: "remember this" })
      expect(yield* runner.status(input.sessionID)).toMatchObject({ pending: true, running: false })
      yield* runner.checkpoint(input)
      expect(calls).toHaveLength(1)
      expect(yield* runner.status(input.sessionID)).toMatchObject({ pending: false, running: false })
    }),
  )

  it.live("a rejected review makes no durable edits", () =>
    Effect.gen(function* () {
      const runner = yield* RefinementRunner.Service
      const store = yield* Refinement.Service
      yield* runner.checkpoint({
        sessionID: "reject",
        turnID: "one",
        compact: true,
        trajectory: "No useful lesson",
        complete: () => Effect.succeed('{"shouldRefine":false,"rationale":"Noise"}'),
      })
      expect(yield* store.read({ sessionID: "reject", scope: "local" })).toEqual(empty)
    }),
  )

  it.live("interrupting refinement clears running state and never writes a proposal", () =>
    Effect.gen(function* () {
      const runner = yield* RefinementRunner.Service
      const store = yield* Refinement.Service
      const started = yield* Deferred.make<void>()
      const fiber = yield* runner
        .checkpoint({
          sessionID: "cancel",
          turnID: "one",
          trajectory: "lesson",
          request: {},
          complete: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(yield* runner.status("cancel")).toMatchObject({ running: true })
      yield* Fiber.interrupt(fiber)
      expect(yield* runner.status("cancel")).toMatchObject({ running: false, outcome: { status: "cancelled" } })
      expect(yield* store.read({ sessionID: "cancel", scope: "local" })).toEqual(empty)
    }),
  )

  it.live("memory tool applies and reads the actual ledger", () =>
    Effect.gen(function* () {
      const store = yield* Refinement.Service
      const runner = yield* RefinementRunner.Service
      yield* RefinementMemory.execute(store, runner, "tool", { action: "apply", proposal })
      const content = yield* RefinementMemory.execute(store, runner, "tool", {
        action: "get",
        kind: "memory",
        id: "package-tests",
      })
      expect(content).toContain("Root test invocation failed")
      expect(yield* store.context("tool")).toContain("Run tests from package directories")
    }),
  )
})
