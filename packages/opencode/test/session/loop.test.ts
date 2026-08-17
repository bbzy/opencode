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
  test("reflects after two dry rounds and pauses after one post-reflection dry round", () => {
    expect(Loop.loopConfig.maxDryIterations).toBe(2)
    expect(Loop.loopConfig.maxPostReflectionDryIterations).toBe(1)
  })

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

  test("cycle round prompts carry scheduler context without repeating the previous response", () => {
    const prompt = Loop.buildCyclePrompt(5, {
      consecutiveDry: 2,
      postReflection: false,
    })
    expect(prompt).toContain("[Cycle #5] Automated cycle — iteration 5.")
    expect(prompt).not.toContain("Last completed iteration")
    expect(prompt).toContain(
      `Tool activity: 2/${Loop.loopConfig.maxDryIterations} consecutive completed rounds without a tool call`,
    )
    expect(prompt).not.toContain("duplicate delivery")
    expect(prompt).not.toContain("CYCLE_OUTCOME")
  })

  test("cycle injects the reflection contract without imposing a phase sequence", () => {
    const reflect = Loop.buildCyclePrompt(4, {
      consecutiveDry: Loop.loopConfig.maxDryIterations,
      postReflection: false,
    })
    expect(reflect).toContain("Reflection trigger")
    expect(reflect).toContain("<cycle-reflect>")
    expect(reflect).toContain("Challenge stale assumptions")
    expect(reflect).toContain("Do not load cycle-reflect with the skill tool")
    expect(reflect).toContain("excluded from tool-activity counting")
    expect(reflect).not.toContain("Planning escalation")

    const afterReflect = Loop.buildCyclePrompt(5, { consecutiveDry: 1, postReflection: true })
    expect(afterReflect).not.toContain("Reflection trigger")
    expect(afterReflect).not.toContain("<cycle-reflect>")
    expect(afterReflect).not.toContain("Planning escalation")
    expect(afterReflect).toContain(`Post-reflection tool activity: 1/${Loop.loopConfig.maxPostReflectionDryIterations}`)
    expect(afterReflect).toContain(`will pause if this reaches ${Loop.loopConfig.maxPostReflectionDryIterations}`)
  })

  test("cycle round prompts omit context lines when there is nothing to report", () => {
    const prompt = Loop.buildCyclePrompt(1, { consecutiveDry: 0, postReflection: false })
    expect(prompt).not.toContain("Last completed iteration")
    expect(prompt).not.toContain("Tool-free status")
    expect(prompt).not.toContain("Unfinished todos")
    expect(prompt).not.toContain("CYCLE_CHAOS")
    expect(prompt).not.toContain("duplicate delivery")
    expect(prompt).not.toContain("CYCLE_OUTCOME")
  })

  test("post-compaction context reloads the owner skill and carries the complete todo snapshot", () => {
    const context = Loop.buildPostCompactionContext([
      { content: "finish compact handoff", status: "in_progress", priority: "high" },
      { content: "verify resume", status: "pending", priority: "medium" },
    ])
    expect(context).toContain("load the cycle-on-project skill")
    expect(context).toContain('"content": "finish compact handoff"')
    expect(context).toContain('"status": "pending"')
  })

  test("roundUsedTool observes any tool call without classifying its semantics", () => {
    expect(Loop.roundUsedTool(round(toolPart({ tool: "read", status: "completed" })), "m1")).toBe(true)
    expect(Loop.roundUsedTool(round(toolPart({ tool: "edit", status: "completed" })), "m1")).toBe(true)
    expect(Loop.roundUsedTool(round(toolPart({ tool: "future-shell", status: "completed" })), "m1")).toBe(true)
    expect(Loop.roundUsedTool(round(toolPart({ tool: "bash", status: "error" })), "m1")).toBe(true)
    expect(Loop.roundUsedTool(round(), "m1")).toBe(false)
  })

  test("responseFingerprint ignores changing round references", () => {
    expect(Loop.responseFingerprint("DONE — same as #40-129")).toBe(Loop.responseFingerprint("DONE — same as #40-130"))
  })

  test("roundUsedTool only observes messages past the boundary", () => {
    const messages = round(toolPart({ tool: "bash", status: "completed", command: "bun typecheck" }))
    expect(Loop.roundUsedTool(messages, "m1")).toBe(true)
    expect(Loop.roundUsedTool(messages, "m2")).toBe(false)
    expect(Loop.roundUsedTool(messages, undefined)).toBe(true)
  })
})
