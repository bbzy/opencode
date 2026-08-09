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

  test("cycle round prompts omit the misleading Next clock time", () => {
    expect(Loop.buildCyclePrompt(3)).not.toContain("Next:")
    expect(Loop.buildCyclePrompt(3)).toContain("[Cycle #3] Automated cycle — iteration 3.")
  })

  test("cycle round prompts carry cross-round context", () => {
    const prompt = Loop.buildCyclePrompt(5, {
      consecutiveDry: 2,
      previous: { round: 4, summary: "fixed the null deref in GraphAddConditionalNode" },
    })
    expect(prompt).toContain("[Cycle #5] Automated cycle — iteration 5.")
    expect(prompt).toContain("Last completed iteration: #4 — fixed the null deref in GraphAddConditionalNode")
    expect(prompt).toContain("Idle status: 2/3")
    expect(prompt).toContain("duplicate delivery")
    expect(prompt).toContain("DONE")
  })

  test("cycle round prompts omit context lines when there is nothing to report", () => {
    const prompt = Loop.buildCyclePrompt(1, { consecutiveDry: 0 })
    expect(prompt).not.toContain("Last completed iteration")
    expect(prompt).not.toContain("Idle status")
    expect(prompt).not.toContain("Unfinished todos")
    expect(prompt).toContain("duplicate delivery")
    expect(prompt).toContain("DONE")
  })

  test("cycle round prompts list unfinished todos and gate the DONE exit", () => {
    const prompt = Loop.buildCyclePrompt(2, {
      consecutiveDry: 0,
      pendingTodos: ["Verify the build compiles", "Sync the fix to the reference demo"],
    })
    expect(prompt).toContain('Unfinished todos (2): "Verify the build compiles", "Sync the fix to the reference demo"')
    expect(prompt).toContain("before declaring DONE")
    expect(prompt).toContain("no unfinished todos remain")
  })

  test("cycle round prompts omit the todos line when none are pending", () => {
    expect(Loop.buildCyclePrompt(2, { consecutiveDry: 0, pendingTodos: [] })).not.toContain("Unfinished todos")
  })

  test("roundMadeProgress counts file-modifying tools and VCS mutations only", () => {
    expect(Loop.roundMadeProgress(round(toolPart({ tool: "edit", status: "completed" })), "m1")).toBe(true)
    expect(Loop.roundMadeProgress(round(toolPart({ tool: "edit", status: "error" })), "m1")).toBe(false)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "bash", status: "completed", command: "jj split src/x.ts" })),
        "m1",
      ),
    ).toBe(true)
    expect(
      Loop.roundMadeProgress(round(toolPart({ tool: "bash", status: "completed", command: "git commit -m x" })), "m1"),
    ).toBe(true)
    expect(
      Loop.roundMadeProgress(
        round(toolPart({ tool: "bash", status: "completed", command: "jj bookmark move main abc" })),
        "m1",
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
  })

  test("roundMadeProgress only counts messages past the boundary", () => {
    const messages = round(toolPart({ tool: "edit", status: "completed" }))
    expect(Loop.roundMadeProgress(messages, "m1")).toBe(true)
    expect(Loop.roundMadeProgress(messages, "m2")).toBe(false)
    expect(Loop.roundMadeProgress(messages, undefined)).toBe(true)
  })
})
