import type { LoopState2 } from "@opencode-ai/sdk/v2"

export function formatLoopState(state: LoopState2): string {
  const round = state.rounds > 0 ? `#${state.rounds}` : ""
  const consecutiveDry = state.consecutiveDry ?? 0
  const dry = consecutiveDry > 0 ? ` ${consecutiveDry} no-progress` : ""
  const failed = state.lastStatus === "fail" ? " failed" : ""
  if (state.paused)
    return `CYCLE ${round}(${state.pauseReason ? `paused: ${state.pauseReason}` : "paused"}${dry ? `,${dry}` : ""})`.trim()
  if (state.running) return `CYCLE ${round}(running${failed}${dry})`.trim()
  if (state.pending) return `CYCLE ${round}(queued${failed}${dry})`.trim()
  return `CYCLE ${round}(${state.intervalStr}${failed})${dry}`.trim()
}
