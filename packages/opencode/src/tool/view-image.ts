import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { isImageAttachment, sniffAttachmentMime } from "@/util/media"
import { generateText, type ModelMessage } from "ai"
import { Effect, Schema } from "effect"
import * as path from "path"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import DESCRIPTION from "./view-image.txt"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the image file to analyze" }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "What to ask about the image. When omitted, the vision model returns a detailed description.",
  }),
})

type Metadata = {
  model: string
  filePath: string
}

export const ViewImageTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Provider.Service | Config.Service
>(
  "view_image",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service

    const resolveModel = Effect.fn("ViewImage.resolveModel")(function* (names: string[]) {
      const providers = yield* provider.list()
      for (const name of names) {
        const model = yield* matchModel(providers, name)
        if (model) return model
      }
      const available = Object.values(providers)
        .flatMap((info) => Object.keys(info.models))
        .slice(0, 20)
        .join(", ")
      return yield* Effect.fail(
        new Error(
          `None of the configured image_models (${names.join(", ")}) resolve to a connected provider model.` +
            (available ? ` Available models: ${available}` : " No providers are connected."),
        ),
      )
    })

    // image_models entries are "provider/model" pairs so the model is pinned
    // precisely; the model part may itself contain slashes (e.g.
    // "astra/minimax_m3_code/infer"). Entries are tried in order and the first
    // one that exists on a connected provider wins.
    const matchModel = Effect.fn("ViewImage.matchModel")(function* (
      providers: Record<Provider.Info["id"], Provider.Info>,
      name: string,
    ) {
      const { providerID, modelID } = Provider.parseModel(name)
      const info = providers[providerID]
      if (!info || !info.models[modelID]) return undefined
      return yield* provider.getModel(providerID, modelID)
    })

    const run = Effect.fn("ViewImage.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) filepath = path.resolve(instance.directory, filepath)
      if (process.platform === "win32") filepath = FSUtil.normalizePath(filepath)
      const title = path.relative(instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )
      if (!stat || stat.type === "Directory") {
        return yield* Effect.fail(new Error(`File not found or not a file: ${filepath}`))
      }

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: "file",
      })
      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      const bytes = yield* fs.readFile(filepath)
      const mime = sniffAttachmentMime(bytes, FSUtil.mimeType(filepath))
      if (!isImageAttachment(mime)) {
        return yield* Effect.fail(new Error(`Not a supported image file: ${filepath} (${mime})`))
      }

      const cfg = yield* config.get()
      const names = cfg.image_models ?? []
      if (names.length === 0) {
        return yield* Effect.fail(
          new Error(`image_models is not configured. Add vision model names (e.g. "gpt-4o") to the image_models config.`),
        )
      }
      const model = yield* resolveModel(names)
      const language = yield* provider.getLanguage(model)

      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            { type: "image", image: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` },
            { type: "text", text: params.prompt ?? "Describe this image in detail." },
          ],
        },
      ]
      const result = yield* Effect.tryPromise(() =>
        generateText({ model: language, messages, abortSignal: ctx.abort }),
      ).pipe(
        Effect.mapError((error) => new Error(`Vision model ${model.providerID}/${model.id} failed: ${String(error)}`)),
      )

      return {
        title,
        output: result.text,
        metadata: { model: `${model.providerID}/${model.id}`, filePath: filepath },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
