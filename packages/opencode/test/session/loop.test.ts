import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Loop } from "@/session/loop"

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
    expect(prompt).toContain("duplicate delivery")
    expect(prompt).toContain("DONE")
  })

  test("round-trips a persisted cycle state", () => {
    const state: Loop.SerializedLoopState = {
      version: 1,
      intervalStr: "every 3m",
      schedule: { type: "cycle", intervalMs: 180_000 },
      rounds: 4,
      startedAt: 1_000_000,
      nextRunAt: 1_180_000,
      paused: false,
      pending: false,
      running: false,
      consecutiveFailures: 0,
      consecutiveDry: 1,
      coalescedCount: 2,
      timezone: "local",
      commandSeq: 0,
    }
    const decoded = Schema.decodeUnknownSync(Loop.SerializedLoopState)(state)
    expect(decoded).toEqual(state)
  })
})