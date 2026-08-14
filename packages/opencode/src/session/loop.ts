import { Effect, Fiber, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export const loopConfig = {
  minIntervalMs: 30_000,
  maxConsecutiveFailures: 5,
  // Consecutive rounds without file or VCS changes before the scheduler
  // challenges the agent with the cycle skill's Reflect phase.
  maxDryIterations: 3,
  // Dry Plan rounds get a bounded opportunity to find higher-level work.
  // After this many additional dry rounds, pause for user redirection.
  maxPlanDryIterations: 3,
  // Require the model to independently confirm an exhausted/blocked verdict
  // before pausing, so one overly eager DONE cannot end unattended work.
  maxConsecutiveExhausted: 2,
  // Catch cross-round text loops that do not use the structured outcome.
  maxConsecutiveDuplicateResponses: 3,
  // Provider returned nothing (no parts, zero output tokens) this many times
  // in a row — the provider is broken, not the task; stop instead of pausing.
  maxEmptyRounds: 2,
  // Proactively compact between rounds once the last round's token count
  // reaches this fraction of the usable context. Overflow-triggered
  // compaction fires only at the ceiling, where summarizing the whole
  // history no longer fits and fails — compacting earlier keeps that path
  // from ever running.
  compactionThreshold: 0.7,
  // Chaos is sampled periodically, and immediately when the scheduler has
  // already observed a risk signal such as a no-progress round.
  chaosAssessmentInterval: 3,
  // A cycle round should land one verifiable unit and yield. The final grace
  // turn has no tools and is ended by the engine, so in-flight tools are never
  // interrupted but the model cannot expand the round indefinitely.
  maxRoundProviderTurns: 20,
}

export const FILE_MODIFY_TOOLS = new Set(["edit", "write", "apply_patch"])

// jj/git history or working-copy mutations never show up as
// edit/write/apply_patch parts; without counting them, legitimate repository
// tidying rounds (splitting an accidental file out of a commit, squashing,
// rewording) are misjudged as idle. Read-only subcommands (st/log/diff/
// status/bookmark list) deliberately don't match.
const VCS_MUTATION_PATTERN =
  /\b(?:jj|git)\s+(?:commit|split|squash|desc(?:ribe)?|abandon|rebase|new|merge|cherry-pick|revert|restore|reset|amend|undo|tag|bookmark\s+(?:move|create|delete|set|rename|track|untrack|forget))\b/

const VALIDATION_PATTERN =
  /(?:^|(?:&&|;|\|)\s*)(?:(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)(?:bun\s+(?:test|typecheck|run\s+(?:test|typecheck|lint|check|build))|npm\s+(?:test|run\s+(?:test|typecheck|lint|check|build))|pnpm\s+(?:test|run\s+(?:test|typecheck|lint|check|build))|yarn\s+(?:test|typecheck|lint|check|build)|cargo\s+(?:test|check|clippy|build)|go\s+test|pytest|ctest|cmake\s+--build|(?:\.\/)?gradlew?\s+[^;&|]*(?:test|check|lint|assemble|build)|make\s+(?:test|check|lint|build)|ninja(?:\s|$))/i

const DESTRUCTIVE_OPERATION_PATTERN =
  /(?:\brsync\b[^;&|]*\s--delete\b|\bgit\s+(?:checkout|reset)\b|\brm\s+[^;&|]*(?:-[A-Za-z]*r|--recursive)\b)/i

function completedCommand(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "bash" || part.state?.status !== "completed") return
  const command = (part.state.input as { command?: unknown } | undefined)?.command
  return typeof command === "string" ? command.trim().replace(/\s+/g, " ") : undefined
}

function completedToolSignature(part: SessionV1.Part) {
  if (part.type !== "tool" || part.state?.status !== "completed") return
  return `${part.tool}:${JSON.stringify(part.state.input)}`
}

export type RoundProgress = {
  kind: "validated" | "committed" | "diagnosed" | "todo" | "none"
  goal: string
  evidence: string
}

export function roundProgress(response: string): RoundProgress | undefined {
  const marker = response.lastIndexOf("CYCLE_PROGRESS")
  if (marker < 0) return
  const block = response.slice(marker)
  const kind = block.match(/^kind:\s*(validated|committed|diagnosed|todo|none)\s*$/im)?.[1] as
    | RoundProgress["kind"]
    | undefined
  const goal = block.match(/^goal:\s*(.+)$/im)?.[1]?.trim()
  const evidence = block.match(/^evidence:\s*(.+)$/im)?.[1]?.trim()
  if (!kind || !goal || !evidence) return
  return { kind, goal, evidence }
}

// Did the round produce new evidence or durable progress? A successful
// validation command counts once, but repeating the same green command in a
// later round does not let a cycle evade its dry budget indefinitely.
export function roundMadeProgress(
  messages: readonly { info: { id: string; role: string }; parts: readonly SessionV1.Part[] }[],
  boundaryId: string | undefined,
  response = "",
  todoChanged = false,
) {
  const previousValidations = new Set(
    messages
      .filter((msg) => msg.info.role === "assistant" && boundaryId && msg.info.id <= boundaryId)
      .flatMap((msg) => msg.parts)
      .map(completedCommand)
      .filter((command): command is string => !!command && VALIDATION_PATTERN.test(command)),
  )
  const previousTools = new Set(
    messages
      .filter((msg) => msg.info.role === "assistant" && boundaryId && msg.info.id <= boundaryId)
      .flatMap((msg) => msg.parts)
      .map(completedToolSignature)
      .filter((signature): signature is string => !!signature),
  )
  const parts = messages
    .filter((msg) => msg.info.role === "assistant" && (!boundaryId || msg.info.id > boundaryId))
    .flatMap((msg) => msg.parts)
    .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.state?.status === "completed")
  const commands = parts.map(completedCommand).filter((command): command is string => !!command)
  const committed = commands.some((command) => VCS_MUTATION_PATTERN.test(command))
  const validated = commands.some((command) => VALIDATION_PATTERN.test(command) && !previousValidations.has(command))
  const declared = roundProgress(response)
  if (!declared || declared.kind === "none") return false
  const todo = todoChanged && parts.some((part) => part.tool === "todowrite")
  const diagnosed = parts.some(
    (part) =>
      !FILE_MODIFY_TOOLS.has(part.tool) &&
      part.tool !== "todowrite" &&
      !previousTools.has(completedToolSignature(part)!),
  )
  return committed || validated || todo || diagnosed
}

export type RoundOutcome = "exhausted" | "blocked"

export function roundOutcome(response: string): RoundOutcome | undefined {
  const marker = response
    .trim()
    .split("\n")
    .findLast((line) => line.trim())
    ?.trim()
    .match(/^CYCLE_OUTCOME:\s*(exhausted|blocked)$/i)?.[1]
  if (marker === "exhausted" || marker === "blocked") return marker
}

export function eligibleRoundOutcome(response: string, todos: readonly { status: string }[]) {
  const outcome = roundOutcome(response)
  if (todos.some((item) => item.status !== "completed" && item.status !== "cancelled" && item.status !== "blocked"))
    return
  return outcome
}

export function responseFingerprint(response: string) {
  return response
    .replace(/\n?CYCLE_CHAOS[\s\S]*?(?=\nCYCLE_OUTCOME:|$)/gi, "")
    .replace(/\n?CYCLE_PROGRESS[\s\S]*?(?=\nCYCLE_CHAOS|\nCYCLE_OUTCOME:|$)/gi, "")
    .replace(/#\d+(?:-\d+)?/g, "#")
    .replace(/\b(?:iteration|round)\s+\d+\b/gi, "round #")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

const CycleSchedule = Schema.Struct({
  type: Schema.Literal("cycle"),
  intervalMs: Schema.Number,
})

export const ScheduleInfo = CycleSchedule
export type ScheduleInfo = Schema.Schema.Type<typeof ScheduleInfo>

// In-memory only: cycle state lives and dies with the process. No
// persistence, no cross-process ownership, no recovery on restart.
export type LoopState = {
  intervalStr: string
  schedule: ScheduleInfo
  rounds: number
  startedAt: number
  nextRunAt: number
  paused: boolean
  pending: boolean
  running: boolean
  consecutiveFailures: number
  consecutiveDry: number
  consecutiveExhausted: number
  consecutiveDuplicateResponses: number
  consecutiveEmpty: number
  coalescedCount: number
  lastStatus?: "success" | "fail"
  timezone: string
  lastChaos?: ChaosAssessment & { round: number }
  lastResponseFingerprint?: string
  fiber: Fiber.Fiber<void, unknown>
  trigger: (opts?: { queueWhenBusy?: boolean }) => Effect.Effect<void>
}

export type ChaosAssessment = {
  score: number
  stateClarity: number
  historyNoise: number
  conflictDrift: number
  executionContinuity: number
  contextPressure: number
  reason?: string
}

export type RoundObservations = {
  providerTurns?: number
  toolCalls?: number
  toolErrors?: number
  durationMs?: number
  contextUsage?: number
  destructiveOperations?: number
}

const chaosDimensions = [
  ["state_clarity", "stateClarity", 7.5],
  ["history_noise", "historyNoise", 5],
  ["conflict_drift", "conflictDrift", 6.25],
  ["execution_continuity", "executionContinuity", 3.75],
  ["context_pressure", "contextPressure", 2.5],
] as const

export function chaosAssessment(response: string, observations: RoundObservations = {}): ChaosAssessment | undefined {
  const marker = response.lastIndexOf("CYCLE_CHAOS")
  if (marker < 0) return
  const block = response.slice(marker)
  const values = Object.fromEntries(
    chaosDimensions.flatMap(([label, key]) => {
      const value = Number(block.match(new RegExp(`^${label}:\\s*([0-4])\\s*$`, "mi"))?.[1])
      return Number.isInteger(value) ? [[key, value]] : []
    }),
  ) as Partial<Record<(typeof chaosDimensions)[number][1], number>>
  if (chaosDimensions.some(([, key]) => values[key] === undefined)) return
  const reason = block.match(/^reason:\s*(.+)$/im)?.[1]?.trim()
  const scale = Math.max(observations.providerTurns ?? 0, observations.toolCalls ?? 0)
  const calibrated = {
    stateClarity: Math.max(values.stateClarity!, (observations.destructiveOperations ?? 0) > 0 ? 2 : 0),
    historyNoise: Math.max(values.historyNoise!, scale >= 80 ? 2 : scale >= 40 ? 1 : 0),
    conflictDrift: values.conflictDrift!,
    executionContinuity: Math.max(
      values.executionContinuity!,
      scale >= 80 || (observations.destructiveOperations ?? 0) > 0 ? 3 : scale >= 40 ? 2 : scale >= 20 ? 1 : 0,
      (observations.durationMs ?? 0) >= 60 * 60 * 1000
        ? 2
        : (observations.durationMs ?? 0) >= 30 * 60 * 1000
          ? 1
          : 0,
      (observations.toolErrors ?? 0) >= 3 ? 2 : (observations.toolErrors ?? 0) > 0 ? 1 : 0,
    ),
    contextPressure: Math.max(
      values.contextPressure!,
      (observations.contextUsage ?? 0) >= 0.7 ? 3 : (observations.contextUsage ?? 0) >= 0.5 ? 2 : 0,
    ),
  }
  return {
    score: Math.round(chaosDimensions.reduce((total, [, key, weight]) => total + calibrated[key] * weight, 0)),
    ...calibrated,
    ...(reason ? { reason } : {}),
  }
}

export function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
}

const durationUnitRegex = /^(?:\d+\s*(?:ms|s|m|h)\s*)+$/i
const durationPartRegex = /(\d+)\s*(ms|s|m|h)/gi
export function parseDuration(input: string): number | undefined {
  if (!durationUnitRegex.test(input)) return undefined
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
  const totalMs = [...input.matchAll(durationPartRegex)].reduce((sum, [, num, unit]) => {
    return sum + Number(num) * (multipliers[unit.toLowerCase()] ?? 0)
  }, 0)
  return totalMs > 0 ? totalMs : undefined
}

export function nextScheduledAt(schedule: ScheduleInfo, now: number) {
  return now + schedule.intervalMs
}

export function scheduleMode(): "cycle" {
  return "cycle"
}

export function roundNeedsCheckpoint(providerTurns: number) {
  return providerTurns >= loopConfig.maxRoundProviderTurns
}

export function roundMustYield(providerTurns: number) {
  return providerTurns > loopConfig.maxRoundProviderTurns
}

export function roundObservations(
  messages: readonly { info: { id: string; role: string }; parts: readonly SessionV1.Part[] }[],
  boundaryId: string | undefined,
  input: { durationMs: number; contextUsage: number },
): RoundObservations {
  const current = messages.filter(
    (message) => message.info.role === "assistant" && (!boundaryId || message.info.id > boundaryId),
  )
  const tools = current.flatMap((message) => message.parts).filter((part) => part.type === "tool")
  const commands = tools.map(completedCommand).filter((command): command is string => !!command)
  return {
    providerTurns: current.length,
    toolCalls: tools.length,
    toolErrors: tools.filter((part) => part.state.status === "error").length,
    durationMs: input.durationMs,
    contextUsage: input.contextUsage,
    destructiveOperations: commands.filter((command) => DESTRUCTIVE_OPERATION_PATTERN.test(command)).length,
  }
}

// Cycle prompts omit "Next:" deliberately: the next round starts <interval>
// after this round *ends*, so any clock time shown here would be wrong for
// rounds longer than the interval.
export function buildCyclePrompt(
  round: number,
  context?: {
    consecutiveDry: number
    consecutiveExhausted?: number
    pendingTodos?: readonly string[]
    blockedTodos?: readonly string[]
    assessChaos?: boolean
    contextUsage?: number
  },
) {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  const time = now.toTimeString().slice(0, 5)
  const lines = [`[Cycle #${round}] Automated cycle — iteration ${round}. ${date} ${time}.`]
  if (context && context.consecutiveDry > 0) {
    lines.push(
      `No-progress status: ${context.consecutiveDry}/${loopConfig.maxDryIterations} consecutive iterations without durable changes or new validation evidence before mandatory reflection.`,
    )
  }
  if (context && context.consecutiveDry === loopConfig.maxDryIterations) {
    lines.push(
      `Reflection challenge: load the cycle-on-project skill and perform its Reflect phase now. Do not rubber-stamp the previous work. Challenge its design, test coverage, process, commit organization, and the health of the wider scope. Turn surviving concerns into candidates, compare them with the existing backlog by user impact, risk, blocking value, cost, evidence, and authorization, then act on the highest-value in-scope candidate. A newly discovered concern does not automatically outrank existing work. Proceed to Plan only if every dimension passes an honest review.`,
    )
  }
  if (context && context.consecutiveDry > loopConfig.maxDryIterations) {
    lines.push(
      `Planning escalation: the Reflect phase found no issue requiring rework. Load the cycle-on-project skill and perform its Plan phase now. Think as the responsible owner at a higher level, compare concrete in-scope candidates by user impact, risk, blocking value, cost, evidence, and authorization, then start the highest-value one yourself. Widen the frontier only when the user did not define a fixed scope. Do not invent work merely to remain active: a possible improvement is not viable when its value, certainty, authorization, or benefit-to-cost ratio cannot justify another round.`,
    )
  }
  if (context?.consecutiveExhausted) {
    lines.push(
      `The previous ${context.consecutiveExhausted} iteration(s) reported an exhausted or externally blocked outcome. Confirm it with a low-cost, read-only review. Resume only if new evidence reveals a viable candidate inside the same authorization and safety boundary. Do not weaken a previously established blocker, reinterpret a user-required physical action as authorization to control their applications, or perform external UI/account actions merely to overturn the verdict. If external conditions have not changed, preserve the unblock condition and confirm the outcome.`,
    )
  }
  if (context?.assessChaos) {
    lines.push(
      `At the end of this iteration, assess how risky it would be to carry the full session history into another round. This measures conversation health, not project difficulty or remaining workload. Score each dimension from 0 (healthy) to 4 (severely chaotic), then include this exact block after your work report:`,
      `CYCLE_CHAOS`,
      `state_clarity: <0-4>`,
      `history_noise: <0-4>`,
      `conflict_drift: <0-4>`,
      `execution_continuity: <0-4>`,
      `context_pressure: <0-4>`,
      `reason: <one concise sentence>`,
      ...(context.contextUsage !== undefined
        ? [
            `Engine context utilization: ${Math.round(context.contextUsage * 100)}%. Use this as evidence for context pressure, not as the total chaos score.`,
          ]
        : []),
      `State clarity asks whether scope, current work, completed work, blockers, and next evidence are unambiguous. History noise measures obsolete or repetitive material. Conflict drift measures contradictions and scope/state drift. Execution continuity measures repetition, open branches, and missing closure. Context pressure measures whether the history is becoming hard to use. Do not calculate a total score; the engine does that.`,
    )
  }
  if (context?.pendingTodos && context.pendingTodos.length > 0) {
    const todos = context.pendingTodos.slice(0, 10).map((content) => `"${content.slice(0, 120)}"`)
    lines.push(
      `Unfinished todos (${context.pendingTodos.length}): ${todos.join(", ")}. Resolve them or explicitly close them before declaring DONE.`,
    )
  }
  if (context?.blockedTodos && context.blockedTodos.length > 0) {
    const todos = context.blockedTodos.slice(0, 10).map((content) => `"${content.slice(0, 120)}"`)
    lines.push(
      `Blocked tasks (${context.blockedTodos.length}): ${todos.join(", ")}. A blocked task does not block the responsibility scope: preserve its unblock condition and choose another worthwhile in-scope candidate. Treat explicit user action, physical interaction, account access, external communication, and authorization requirements as hard boundaries until conditions actually change. Report CYCLE_OUTCOME: blocked only when Check, Reflect, and Plan confirm that the entire scope has no worthwhile independently actionable work.`,
    )
  }
  lines.push(
    `Unattended risk boundary: prefer bounded and reversible work. Do not introduce a new destructive surface merely to stay active. Before delete-sync, recursive cleanup, history/worktree replacement, generated-artifact removal, external UI/account control, deployment, or publication, require explicit prior authorization or a clearly established project workflow; use a read-only dry run first and verify a trustworthy recovery source. When the main objective is already complete, accept only lower-risk follow-up candidates.`,
    `Before ending, reconcile the todo list with this report: complete achieved items, mark externally waiting items blocked with the unblock condition in their content, add material candidates, and close stale candidates explicitly. Then include this exact block:`,
    `CYCLE_PROGRESS`,
    `kind: <validated|committed|diagnosed|todo|none>`,
    `goal: <the responsibility-scope objective advanced this round>`,
    `evidence: <the new validation, commit, diagnostic fact, todo transition, or why none>`,
    `Choose the kind that best describes the strongest evidence: validated for a newly successful relevant check, committed for a durable VCS mutation, diagnosed for new tool-backed evidence that materially changes the problem state, todo for a real work-item state transition, and none when the round produced activity but no durable evidence. The engine considers all observed evidence instead of discarding a round merely because another valid kind would also fit. File edits alone are activity, not progress.`,
  )
  lines.push(
    `If you already completed iteration ${round} or later, treat this as a duplicate delivery: confirm briefly without redoing work.`,
  )
  lines.push(
    `If Check, Reflect, and Plan confirm that no remaining candidate has enough value, certainty, authorization, or benefit-to-cost ratio to justify another round, say DONE with a one-line reason and end the response with exactly CYCLE_OUTCOME: exhausted.`,
  )
  lines.push(
    `Use CYCLE_OUTCOME: blocked instead only when the entire responsibility scope has no worthwhile independently actionable work because every viable path requires external input, authorization, or an unavailable environment. Emit neither marker while actionable todos, unverified fixes, or worthwhile viable candidates remain. Two confirmed outcome rounds pause the scheduler for user redirection.`,
  )
  return lines.join("\n")
}

export * as Loop from "./loop"
