import type { LoopState2 } from "@opencode-ai/sdk/v2"

export function formatLoopState(state: LoopState2): string {
  const round = state.rounds > 0 ? `#${state.rounds}` : ""
  const consecutiveDry = state.consecutiveDry ?? 0
  const dry = consecutiveDry > 0 ? ` ${consecutiveDry} idle` : ""
  if (state.paused) return `CYCLE ${round}(paused${dry ? `,${dry}` : ""})`.trim()
  if (state.running) return `CYCLE ${round}(running${dry})`.trim()
  if (state.pending) return `CYCLE ${round}(queued${dry})`.trim()
  return `CYCLE ${round}(${state.intervalStr})${dry}`.trim()
}