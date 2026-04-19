import { describe, expect, test } from "bun:test"
import { formatLoopState } from "../../src/util/loop"
import type { LoopState2 } from "@opencode-ai/sdk/v2"

function makeState(overrides: Partial<LoopState2> = {}): LoopState2 {
  return {
    mode: "cycle",
    intervalStr: "every 5m",
    rounds: 3,
    startedAt: 1700000000000,
    nextRunAt: 1700000100000,
    paused: false,
    pending: false,
    running: false,
    consecutiveFailures: 0,
    consecutiveDry: 0,
    coalescedCount: 0,
    ...overrides,
  }
}

describe("util.loop.formatLoopState", () => {
  test("active with rounds shows round and interval", () => {
    const state = makeState({ rounds: 3 })
    const label = formatLoopState(state)
    expect(label).toContain("#3")
    expect(label).toContain("every 5m")
  })

  test("rounds=0 omits round number", () => {
    const state = makeState({ rounds: 0 })
    const label = formatLoopState(state)
    expect(label).not.toContain("#")
    expect(label).toContain("every 5m")
  })

  test("paused shows (paused)", () => {
    const state = makeState({ rounds: 5, paused: true })
    expect(formatLoopState(state)).toBe("CYCLE #5(paused)")
  })

  test("paused with 0 rounds", () => {
    const state = makeState({ rounds: 0, paused: true })
    expect(formatLoopState(state)).toBe("CYCLE (paused)")
  })

  test("pending shows (queued)", () => {
    const state = makeState({ rounds: 2, pending: true })
    expect(formatLoopState(state)).toBe("CYCLE #2(queued)")
  })

  test("running shows (running)", () => {
    const state = makeState({ rounds: 2, running: true })
    expect(formatLoopState(state)).toBe("CYCLE #2(running)")
  })

  test("running takes priority over pending", () => {
    const state = makeState({ rounds: 2, running: true, pending: true })
    expect(formatLoopState(state)).toBe("CYCLE #2(running)")
  })

  test("active without paused, running, or pending shows interval", () => {
    const state = makeState({ rounds: 1 })
    expect(formatLoopState(state)).toBe("CYCLE #1(every 5m)")
  })

  test("idle iterations show dry count", () => {
    expect(formatLoopState(makeState({ rounds: 2, consecutiveDry: 1 }))).toContain("1 idle")
    expect(formatLoopState(makeState({ rounds: 2, running: true, consecutiveDry: 2 }))).toBe("CYCLE #2(running 2 idle)")
    expect(formatLoopState(makeState({ rounds: 3, paused: true, consecutiveDry: 3 }))).toBe("CYCLE #3(paused, 3 idle)")
  })
})