/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }
import cycleOnProjectContent from "./skill/cycle-on-project.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent
export const CycleOnProjectContent = cycleOnProjectContent

export const CycleOnProjectDescription =
  "Full specification of cycle-on-project mode — an agent-driven continuous improvement loop where the agent acts as the responsible owner of a scope (user-defined, or expanding from the freshest work toward the whole project by default), carried by opencode's /cycle scheduler (idle-anchored rounds). Load this skill AUTOMATICALLY when the user starts a /cycle automation (e.g. /cycle 3m) or when a [Cycle #N] round prompt arrives; reload it after a context compaction while a cycle is in progress. No command invocation is needed. Do NOT load for /loop (wall-clock scheduling) or for ordinary tasks with no active cycle."

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-opencode",
            description:
              "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.",
            location: AbsolutePath.make("/builtin/customize-opencode.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "cycle-on-project",
            description: CycleOnProjectDescription,
            location: AbsolutePath.make("/builtin/cycle-on-project.md"),
            content: CycleOnProjectContent,
          }),
        }),
      )
    })
  }),
})
