/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }
import cycleOnProjectContent from "./skill/cycle-on-project.md" with { type: "text" }
import cycleReflectContent from "./skill/cycle-reflect.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent
export const CycleOnProjectContent = cycleOnProjectContent
export const CycleReflectContent = cycleReflectContent

export const CycleOnProjectDescription =
  "Minimal responsible-owner contract for opencode's /cycle automation. Load when a [Cycle #N] prompt arrives and this contract is not already visible in the session; reload it after context compaction only when it is missing. Do not reload it on every round. Do not use for /loop or ordinary tasks."

export const CycleReflectDescription =
  "Reflection guidance for a stalled opencode /cycle automation. Use only when a [Cycle #N] scheduler prompt explicitly reports three consecutive rounds without tool activity and asks for cycle-reflect. Do not load at Cycle startup, during ordinary active rounds, for /loop, or for ordinary tasks."

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
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "cycle-reflect",
            description: CycleReflectDescription,
            location: AbsolutePath.make("/builtin/cycle-reflect.md"),
            content: CycleReflectContent,
          }),
        }),
      )
    })
  }),
})
