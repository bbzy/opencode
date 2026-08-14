- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.

## Cycle Automation

- `/cycle` schedules rounds idle-anchored — each round starts `<interval>` after the session became idle. Cycle accepts only intervals.
- Only one automation is active per session; starting a new cycle always replaces the active one (no `--replace` flag). Stop/pause/resume/run/status act on the active cycle.
- The runtime lives in `SessionPrompt` (`startLoopFiber` in `src/session/prompt.ts`, scheduling helpers in `src/session/loop.ts`): one worker consuming a dropping queue, one ticker owning `nextRunAt`, and an `idleWatch` subscription plus a `lastIdleAt` ref that the worker also updates deterministically at round end. Do not give a second writer to `nextRunAt`; the ticker owns it between rounds.
- The cycle prompt message is admitted only after the session drain is acquired (`loopRun` creates the user message inside `state.tryRun`), so a round coalesced by `SessionBusyError` leaves no stray `[Cycle #N]` prompt and consumes no round number. Round prompts carry process-local cross-round context through the current no-progress (`consecutiveDry`) status, the unfinished-todos line (fed from the session todo list when any item is pending/in-progress), a duplicate-delivery instruction, and a DONE exit gated on clean todos + verified fixes + an exhausted Plan phase. They do not repeat a fixed-length tail of the previous response because the next round already sees the session history. Every third round, or immediately after an observed no-progress/failure/repetition signal, the prompt requests a five-dimension `CYCLE_CHAOS` assessment; the engine computes and logs the weighted score for observation only. Keep those lines intact when changing `Loop.buildCyclePrompt`.
- Queue items are tagged `scheduled`/`explicit`. Scheduled ticks coalesce when the session is busy or a round is running, are skipped entirely while paused, and are dropped (not waited out) when caught by a pause; explicit triggers (`run`, resume) pass `queueWhenBusy` and the worker waits out busy/paused stretches instead of dropping them.
- Keep cycle execution process-local until clustering is implemented: cycle state, round summaries, and handoff context live only in the owning opencode process. There is no cross-process ownership, persistence, or restart recovery.
- Round progress is `Loop.roundMadeProgress`: a valid final `CYCLE_PROGRESS` declaration admits the round for evidence checking, then any observed durable evidence may satisfy it — a new successful validation command (including commands with leading environment assignments), a VCS mutation (`jj desc`/commit/split/squash/rebase/etc.), a completed tool-backed diagnosis, or a real `todowrite` transition. File edits alone are activity and do not count. Read-only status checks, repeated green checks, missing declarations, and unverified writes are deliberately excluded. Rounds without progress increment `consecutiveDry`. At `loopConfig.maxDryIterations`, the next prompt challenges the model with the cycle skill's Reflect phase; another dry round escalates to a bounded Plan phase. The scheduler auto-pauses after the Plan dry budget, two confirmed `CYCLE_OUTCOME: exhausted|blocked` verdicts, or repeated materially identical responses. Any progress resets the dry escalation. Consecutive failures still auto-stop at `maxConsecutiveFailures`. User-aborted rounds and user messages admitted during an active unattended round are interventions: they pause the cycle without incrementing failure or empty-response counters, and user work gets the Session drain next.
- Guardrails for runaway automation: the processor has a cross-step doom-loop circuit breaker (`processorConfig.doomLoopHardLimit`, identical tool+input in a row hard-stops the turn), a stream stall watchdog (`processorConfig.stallTimeoutMs`), and an unattended in-flight tool limit (`processorConfig.unattendedToolTimeoutMs`). Shell timeout/abort must interrupt its output reader after killing the process so detached descendants cannot keep the drain alive by retaining a pipe. The cycle worker stops immediately on fatal environment errors, treats round assistant messages carrying non-abort errors as failures, and auto-stops after `loopConfig.maxEmptyRounds` consecutive empty provider responses.
- Context management across rounds: `loopRun` runs a proactive compaction check inside the drain before admitting the round prompt — once the last finished assistant message's token count crosses `loopConfig.compactionThreshold` (fraction of `usable` context), it creates and processes a compaction synchronously. Overflow-triggered compaction only fires at the ceiling where the summarization call itself no longer fits ("Conversation history too large to compact") and bricks the session; the boundary check keeps that path unused. Stream-interruption retries (`finish: "unknown"`) append the turn's already-completed tool calls to the retry prompt so models don't re-apply the same edits.
- Todo status `blocked` means that item is externally waiting and its content must name the unblock condition; blocked items remain visible in round prompts but do not gate a responsibility-scope `CYCLE_OUTCOME: blocked|exhausted`. Pending and in-progress items remain actionable and do gate outcomes. A single blocked task never implies the whole scope is blocked.
- Unattended cycle runs receive a checkpoint at `loopConfig.maxRoundProviderTurns`; the next grace turn receives no tools and is ended by the engine after it reconciles todos and reports evidence. Never reintroduce an unbounded soft-only boundary. In-flight tools are not interrupted by the round boundary.
- Cycle state is process-local and in-memory; do not add persistence or server-start recovery until an explicit design is approved. Wire fields on `LoopEvent.LoopState` use the same rule for version-skewed peers.
- Footer labels render from `session.loop.updated` events.
