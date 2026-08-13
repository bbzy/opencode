import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Loop } from "@/session/loop"

function toolPart(input: { tool: string; status: "completed" | "error"; command?: string }): SessionV1.Part {
  return {
    id: "p1",
    messageID: "m2",
    sessionID: "s1",
    type: "tool",
    tool: input.tool,
    callID: "c1",
    state:
      input.status === "completed"
        ? {
            status: "completed",
            input: input.command ? { command: input.command } : {},
            output: "",
            title: "",
            metadata: {},
            time: { start: 0, end: 1 },
          }
        : { status: "error", input: {}, error: "boom", time: { start: 0, end: 1 } },
  } as SessionV1.Part
}

function round(...tools: SessionV1.Part[]) {
  return [{ info: { id: "m2", role: "assistant" }, parts: tools }]
}

describe("session cycle scheduling", () => {
  test("parses compound durations", () => {
    expect(Loop.parseDuration("2h30m")).toBe(9_000_000)
    expect(Loop.parseDuration("5 minutes")).toBeUndefined()
  })

  test("cycle schedules re-anchor to now plus interval", () => {
    const schedule: Loop.ScheduleInfo = { type: "cycle", intervalMs: 180_000 }
    expect(Loop.nextScheduledAt(schedule, 1_000_000)).toBe(1_180_000)
    expect(Loop.nextScheduledAt(schedule, 20_000_000)).toBe(20_180_000)
  })

  test("schedule mode always returns cycle", () => {
    expect(Loop.scheduleMode()).toBe("cycle")
  })

  test("cycle rounds request a soft checkpoint at the provider-turn budget", () => {
    expect(Loop.roundNeedsCheckpoint(Loop.loopConfig.maxRoundProviderTurns - 1)).toBe(false)
    expect(Loop.roundNeedsCheckpoint(Loop.loopConfig.maxRoundProviderTurns)).toBe(true)
  })

  test("cycle round prompts omit the misleading Next clock time", () => {
    expect(Loop.buildCyclePrompt(3)).not.toContain("Next:")
    expect(Loop.buildCyclePrompt(3)).toContain("[Cycle #3] Automated cycle — iteration 3.")
  })

  test("cycle round prompts carry scheduler context without repeating the previous response", () => {
    const prompt = Loop.buildCyclePrompt(5, {
      consecutiveDry: 2,
    })
    expect(prompt).toContain("[Cycle #5] Automated cycle — iteration 5.")
    expect(prompt).not.toContain("Last completed iteration")
    expect(prompt).toContain("No-progress status: 2/3")
    expect(prompt).toContain("duplicate delivery")
    expect(prompt).toContain("DONE")
  })

  test("cycle challenges dry work with Reflect before escalating to Plan", () => {
    const reflect = Loop.buildCyclePrompt(4, { consecutiveDry: Loop.loopConfig.maxDryIterations })
    expect(reflect).toContain("Reflection challenge")
    expect(reflect).toContain("cycle-on-project skill")
    expect(reflect).not.toContain("Planning escalation")

    const plan = Loop.buildCyclePrompt(5, { consecutiveDry: Loop.loopConfig.maxDryIterations + 1 })
    expect(plan).toContain("Planning escalation")
    expect(plan).toContain("responsible owner")
    expect(plan).toContain("fixed scope")
    expect(plan).not.toContain("Reflection challenge")
  })

  test("cycle round prompts omit context lines when there is nothing to report", () => {
    const prompt = Loop.buildCyclePrompt(1, { consecutiveDry: 0 })
    expect(prompt).not.toContain("Last completed iteration")
    expect(prompt).not.toContain("No-progress status")
    expect(prompt).not.toContain("Unfinished todos")
    expect(prompt).toContain("duplicate delivery")
    expect(prompt).toContain("DONE")
  })

  test("cycle round prompts request a rubric-based chaos assessment", () => {
    const prompt = Loop.buildCyclePrompt(3, { consecutiveDry: 0, assessChaos: true, contextUsage: 0.56 })
    expect(prompt).toContain("CYCLE_CHAOS")
    expect(prompt).toContain("state_clarity: <0-4>")
    expect(prompt).toContain("conversation health, not project difficulty")
    expect(prompt).toContain("Engine context utilization: 56%")
    expect(Loop.buildCyclePrompt(2, { consecutiveDry: 0 })).not.toContain("CYCLE_CHAOS")
  })

  test("chaosAssessment parses the latest complete rubric and calculates its weighted score", () => {
    const result = Loop.chaosAssessment(`
CYCLE_CHAOS
state_clarity: 3
history_noise: 3
conflict_drift: 2
execution_continuity: 2
context_pressure: 3
reason: The state is recoverable but noisy.
`)
    expect(result).toEqual({
      score: 65,
      stateClarity: 3,
      historyNoise: 3,
      conflictDrift: 2,
      executionContinuity: 2,
      contextPressure: 3,
      reason: "The state is recoverable but noisy.",
    })
    expect(Loop.chaosAssessment("CYCLE_CHAOS\nstate_clarity: 4")).toBeUndefined()
    expect(Loop.chaosAssessment("CYCLE_CHAOS\nstate_clarity: 5")).toBeUndefined()
  })

  test("cycle round prompts list unfinished todos and gate the DONE exit", () => {
    const prompt = Loop.buildCyclePrompt(2, {
      consecutiveDry: 0,
      pendingTodos: ["Verify the build compiles", "Sync the fix to the reference demo"],
    })
    expect(prompt).toContain('Unfinished todos (2): "Verify the build compiles", "Sync the fix to the reference demo"')
    expect(prompt).toContain("before declaring DONE")
    expect(prompt).toContain("Emit neither marker while actionable todos")
    expect(prompt).toContain("CYCLE_OUTCOME: exhausted")
  })

  test("cycle round prompts omit the todos line when none are pending", () => {
    expect(Loop.buildCyclePrompt(2, { consecutiveDry: 0, pendingTodos: [] })).not.toContain("Unfinished todos")
  })

  test("cycle round prompts separate blocked work from actionable todos", () => {
    const prompt = Loop.buildCyclePrompt(2, {
      consecutiveDry: 0,
      pendingTodos: ["Implement the fix"],
      blockedTodos: ["Device acceptance — unblock when the user tests the preview"],
    })
    expect(prompt).toContain('Unfinished todos (1): "Implement the fix"')
    expect(prompt).toContain('Blocked tasks (1): "Device acceptance')
    expect(prompt).toContain("entire scope has no worthwhile independently actionable work")
    expect(prompt).toContain("CYCLE_PROGRESS")
    expect(prompt).toContain("File edits alone are activity, not progress")
  })

  test("roundMadeProgress requires durable evidence instead of counting file activity", () => {
    expect(Loop.roundMadeProgress(round(toolPart({ tool: "edit", status: "completed" })), "m1")).toBe(false)
    expect(Loop.roundMadeProgress(round(toolPart({ tool: "edit", status: "error" })), "m1")).toBe(false)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "bash", status: "completed", command: "jj split src/x.ts" })),
        "m1",
        "CYCLE_PROGRESS\nkind: committed\ngoal: organize the change\nevidence: jj split created the focused revision",
      ),
    ).toBe(true)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "bash", status: "completed", command: "git commit -m x" })),
        "m1",
        "CYCLE_PROGRESS\nkind: committed\ngoal: land the fix\nevidence: git commit completed",
      ),
    ).toBe(true)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "bash", status: "completed", command: "jj bookmark move main abc" })),
        "m1",
        "CYCLE_PROGRESS\nkind: committed\ngoal: publish the revision\nevidence: bookmark moved",
      ),
    ).toBe(true)
    expect(Loop.roundMadeProgress(round(toolPart({ tool: "bash", status: "completed", command: "jj st" })), "m1")).toBe(
      false,
    )
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "bash", status: "completed", command: "git status && jj log" })),
        "m1",
      ),
    ).toBe(false)
    expect(
      Loop.roundMadeProgress(round(toolPart({ tool: "bash", status: "completed", command: "jj bookmark list" })), "m1"),
    ).toBe(false)
    expect(Loop.roundMadeProgress(round(toolPart({ tool: "read", status: "completed" })), "m1")).toBe(false)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "bash", status: "completed", command: "bun typecheck" })),
        "m1",
        "CYCLE_PROGRESS\nkind: validated\ngoal: verify the change\nevidence: bun typecheck passed",
      ),
    ).toBe(true)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "read", status: "completed" })),
        "m1",
        "CYCLE_PROGRESS\nkind: diagnosed\ngoal: locate the fault\nevidence: the config selects the removed model",
      ),
    ).toBe(true)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "edit", status: "completed" })),
        "m1",
        "CYCLE_PROGRESS\nkind: diagnosed\ngoal: change code\nevidence: edited a file",
      ),
    ).toBe(false)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "todowrite", status: "completed" })),
        "m1",
        "CYCLE_PROGRESS\nkind: todo\ngoal: reconcile the portfolio\nevidence: device verification moved to blocked",
        true,
      ),
    ).toBe(true)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "todowrite", status: "completed" })),
        "m1",
        "CYCLE_PROGRESS\nkind: todo\ngoal: reconcile the portfolio\nevidence: rewrote the same list",
      ),
    ).toBe(false)
  })

  test("roundProgress parses a complete declaration", () => {
    expect(
      Loop.roundProgress(
        "CYCLE_PROGRESS\nkind: validated\ngoal: protect effect classification\nevidence: targeted test passed 6/6",
      ),
    ).toEqual({ kind: "validated", goal: "protect effect classification", evidence: "targeted test passed 6/6" })
    expect(Loop.roundProgress("CYCLE_PROGRESS\nkind: validated")).toBeUndefined()
  })

  test("roundMadeProgress does not count a repeated validation command", () => {
    const previous = toolPart({ tool: "bash", status: "completed", command: "bun test test/session/loop.test.ts" })
    const current = toolPart({ tool: "bash", status: "completed", command: "bun test test/session/loop.test.ts" })
    const messages = [
      { info: { id: "m1", role: "assistant" }, parts: [previous] },
      { info: { id: "m2", role: "assistant" }, parts: [current] },
    ]
    expect(
      Loop.roundMadeProgress(
        messages,
        "m1",
        "CYCLE_PROGRESS\nkind: validated\ngoal: verify the change\nevidence: repeated test passed",
      ),
    ).toBe(false)
  })

  test("roundMadeProgress does not count repeated diagnostic evidence", () => {
    const messages = [
      { info: { id: "m1", role: "assistant" }, parts: [toolPart({ tool: "read", status: "completed" })] },
      { info: { id: "m2", role: "assistant" }, parts: [toolPart({ tool: "read", status: "completed" })] },
    ]
    expect(
      Loop.roundMadeProgress(
        messages,
        "m1",
        "CYCLE_PROGRESS\nkind: diagnosed\ngoal: inspect the config\nevidence: repeated the same read",
      ),
    ).toBe(false)
  })

  test("roundOutcome requires an exact final structured marker", () => {
    expect(Loop.roundOutcome("DONE — no work remains\nCYCLE_OUTCOME: exhausted")).toBe("exhausted")
    expect(Loop.roundOutcome("Waiting for a device\nCYCLE_OUTCOME: blocked")).toBe("blocked")
    expect(Loop.roundOutcome("CYCLE_OUTCOME: exhausted\nbut one more thing")).toBeUndefined()
    expect(Loop.roundOutcome("DONE")).toBeUndefined()
  })

  test("eligibleRoundOutcome distinguishes actionable, blocked, and exhausted portfolios", () => {
    const exhausted = "DONE\nCYCLE_OUTCOME: exhausted"
    const blocked = "Waiting\nCYCLE_OUTCOME: blocked"
    expect(Loop.eligibleRoundOutcome(exhausted, [])).toBe("exhausted")
    expect(Loop.eligibleRoundOutcome(blocked, [{ status: "blocked" }])).toBe("blocked")
    expect(Loop.eligibleRoundOutcome(exhausted, [{ status: "blocked" }])).toBeUndefined()
    expect(Loop.eligibleRoundOutcome(blocked, [{ status: "pending" }])).toBeUndefined()
  })

  test("responseFingerprint ignores changing round references", () => {
    expect(Loop.responseFingerprint("DONE — same as #40-129")).toBe(Loop.responseFingerprint("DONE — same as #40-130"))
  })

  test("responseFingerprint ignores observational chaos telemetry", () => {
    expect(
      Loop.responseFingerprint(`Still waiting.
CYCLE_CHAOS
state_clarity: 1
history_noise: 2
conflict_drift: 0
execution_continuity: 1
context_pressure: 2
reason: Some old build output remains.`),
    ).toBe(Loop.responseFingerprint("Still waiting."))
  })

  test("responseFingerprint ignores progress declarations", () => {
    expect(
      Loop.responseFingerprint(`Still waiting.
CYCLE_PROGRESS
kind: none
goal: device acceptance
evidence: waiting for the user`),
    ).toBe(Loop.responseFingerprint("Still waiting."))
  })

  test("roundMadeProgress only counts messages past the boundary", () => {
    const messages = round(toolPart({ tool: "bash", status: "completed", command: "bun typecheck" }))
    const progress = "CYCLE_PROGRESS\nkind: validated\ngoal: verify the change\nevidence: bun typecheck passed"
    expect(Loop.roundMadeProgress(messages, "m1", progress)).toBe(true)
    expect(Loop.roundMadeProgress(messages, "m2")).toBe(false)
    expect(Loop.roundMadeProgress(messages, undefined, progress)).toBe(true)
  })
})
