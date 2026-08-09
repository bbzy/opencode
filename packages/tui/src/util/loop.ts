import type { LoopState2 } from "@opencode-ai/sdk/v2"

export function formatLoopState(state: LoopState2): string {
  const round = state.rounds > 0 ? `#${state.rounds}` : ""
  const consecutiveDry = state.consecutiveDry ?? 0
  const dry = consecutiveDry > 0 ? ` ${consecutiveDry} idle` : ""
  const resetInterval = (state as { resetInterval?: number }).resetInterval ?? 0
  const roundsSinceReset = (state as { roundsSinceReset?: number }).roundsSinceReset ?? 0
  const reset = resetInterval > 0 ? ` ${roundsSinceReset}/${resetInterval} to reset` : ""
  if (state.paused) return `CYCLE ${round}(paused${dry ? `,${dry}` : ""})${reset}`.trim()
  if (state.running) return `CYCLE ${round}(running${dry})${reset}`.trim()
  if (state.pending) return `CYCLE ${round}(queued${dry})${reset}`.trim()
  return `CYCLE ${round}(${state.intervalStr})${dry}${reset}`.trim()
}
