# Learned memories and skills

`/refine` reviews the current conversation and saves small, evidence-backed
changes to learned state. It uses a dedicated model request, separate from the
ordinary answer. The agent can also schedule it with the `memory` tool's `refine`
action; scheduled requests run after the current provider response and its tools
settle, before the next provider request.

```text
/refine
/refine focus on the test failures we resolved
/refine --global remember my preferred review workflow
/refine status
/refine list
/refine history
/refine rollback <refinement-id>
/refine export <skill-id>
```

`--global` also applies to list, history, rollback, and export. With no scope
argument, the learned ledger belongs to the current session. Skill files are
automatically published to the shared skill directory regardless of ledger scope. Explicit global entries
are shared across sessions. Local entries override global entries with the same
kind and identifier. Forked sessions start with their own local state.

The four entry kinds are:

- `memory`: verified facts, decisions, preferences, and failure lessons.
- `skill`: repeatable instructions with a concrete trigger and verification.
- `prompt`: narrow supplemental behavior guidance.
- `subagent`: reusable delegation guidance, without registering executable agents.

The model receives saved memory and prompt entries on subsequent turns, and a
catalog of skill and subagent entries that it can inspect with `memory get`.
Context reserves space for up to 40 recently updated entries. Long bodies are
omitted whole, with instructions to load them using `memory get`; catalog overflow
reports an omitted count and points to `memory list`. Long early entries cannot
hide newer entries or truncate the context wrapper.
These notes never replace the base system prompt, current user instructions, or
tool permissions. The `memory` tool supports list, get, apply, history, rollback,
refine, status, and export. Apply accepts explicit create/update/delete edits.

## Automatic review

Automatic review is enabled by default for top-level sessions. It runs at a safe
boundary after 25 completed assistant provider turns, or before context compaction,
with a 20-minute cooldown. A first model request decides whether useful lessons
exist; only an approved review makes a second request to propose edits. Automatic
review writes session-local state. It never promotes entries globally on its own.
Only an `allow` rule for `edit` on `memory:local:*` permits automatic review;
`ask` and `deny` skip it without prompting. Explicit `/refine` requests and
permission-approved `memory refine` calls can still run with `ask`; `deny`
is checked for the requested scope when the review executes.

```json
{
  "refinement": {
    "auto": true,
    "turn_interval": 25,
    "cooldown_ms": 1200000,
    "compact": true
  }
}
```

Set `auto` to false to disable automatic reviews while keeping manual refinement
and saved memories. `compact: false` disables the compaction trigger; normal turn
thresholds still apply. Reviews use the session model, wait for completion without
a refinement-specific timeout, and cannot call tools. Failed automatic reviews are logged and do not fail the
user's task. User interruption cancels the review. Scheduling and cooldown state
are process-local and reset on restart; saved entries and history persist.

Reviews that have started report completion, failure, or cancellation through the existing
toast events. `/refine status` and `memory status` retain the latest `outcome`,
including `completed`, `unchanged`, `failed`, or `cancelled`, the scope, a message,
and the refinement ID when edits were saved. This outcome is process-local;
saved change history remains available after restart. Notification failures do
not undo saved changes or fail the user's task.
Interrupting a session also clears pending refinement requests and records a
`cancelled` outcome, so an aborted task cannot leave a review for a later task.

Review inputs have a bounded serialized size (under 96,000 characters), including
JSON escaping. Editable entries are included whole within their section budget;
other-scope entries and recent history use summaries. Omitted entries are counted,
and the trajectory keeps its most recent evidence. Reviews must not replace an
entry using a truncated description.

## Persistence, rollback, and export

State is stored under opencode's data directory in
`refinement/session-<session-id>/state.json` and `refinement/global/state.json`.
Each file contains entries and their complete before/after change history. Writes
use file locks and atomic replacement. A stale proposal is rejected if an entry
changed while the model was planning. Rollback refuses to overwrite later edits.

Skill creates and updates automatically write standard files to
`~/.config/opencode/refine/skills/<skill-id>/SKILL.md`. New sessions can discover
and load these skills immediately, without manual export or restarting opencode.
Both loaders refresh this directory when listing skills. Ordinary skills retain
precedence over learned skills with the same name. Project-specific procedures
should identify their project in their description and instructions.

The path follows the configured global opencode directory, including
XDG_CONFIG_HOME or OPENCODE_CONFIG_DIR overrides. Ledger scope selects the source
record only; both local and global skills publish to this shared directory.
Updates replace the previous generated content; deletion and rollback synchronize
the file as well. Existing conflicting files, including manual edits and different
skills from another session with the same ID, cause the operation to fail before
changing the ledger. Skill files use atomic replacement, but multiple skill files
and the ledger are not a single filesystem transaction.

`/refine export <skill-id>` remains available to publish older ledger entries.
Existing different files are not overwritten by this explicit export.

The legacy command handler performs management directly. V2 exposes the same
operations through the built-in command template and `memory` tool; a requested
review is applied at the next safe provider-turn boundary.
