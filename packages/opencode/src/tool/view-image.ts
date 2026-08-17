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
    const circuit = {
      signature: "",
      failures: new Map<string, { count: number; message: string }>(),
    }
    const failureLimit = 2

    const resolveModels = Effect.fn("ViewImage.resolveModels")(function* (names: string[]) {
      const providers = yield* provider.list()
      const models = (yield* Effect.forEach(names, (name) => matchModel(providers, name)))
        .filter((model): model is Provider.Model => model !== undefined)
        .filter(
          (model, index, all) =>
            all.findIndex((candidate) => candidate.providerID === model.providerID && candidate.id === model.id) ===
            index,
        )
      if (models.length > 0) return models
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
    // "astra/minimax_m3_code/infer"). Resolved entries remain ordered so a
    // healthy preferred model wins while failed models can fall back.
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
          new Error(
            `image_models is not configured. Add vision model names (e.g. "gpt-4o") to the image_models config.`,
          ),
        )
      }
      const signature = JSON.stringify(names)
      if (circuit.signature !== signature) {
        circuit.signature = signature
        circuit.failures.clear()
      }
      const models = yield* resolveModels(names)
      const key = (model: Provider.Model) => `${model.providerID}/${model.id}`
      const candidates = models
        .filter((model) => (circuit.failures.get(key(model))?.count ?? 0) < failureLimit)
        .toSorted(
          (first, second) =>
            (circuit.failures.get(key(first))?.count ?? 0) - (circuit.failures.get(key(second))?.count ?? 0),
        )
      const first = candidates[0]
      if (!first) {
        return yield* Effect.fail(
          new Error(
            `All configured image_models are disabled after ${failureLimit} consecutive failures. ` +
              models
                .map((model) => {
                  const failure = circuit.failures.get(key(model))
                  return `${key(model)}: ${failure?.message ?? "unavailable"}`
                })
                .join("; ") +
              ". Change image_models or restart opencode before retrying view_image.",
          ),
        )
      }

      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            { type: "image", image: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` },
            { type: "text", text: params.prompt ?? "Describe this image in detail." },
          ],
        },
      ]
      const attempt = (model: Provider.Model) =>
        Effect.suspend(() =>
          ctx.abort.aborted
            ? Effect.interrupt
            : provider.getLanguage(model).pipe(
                Effect.flatMap((language) =>
                  Effect.tryPromise(() => generateText({ model: language, messages, abortSignal: ctx.abort })),
                ),
                Effect.mapError((error) => new Error(`Vision model ${key(model)} failed: ${String(error)}`)),
                Effect.tapError((error) =>
                  ctx.abort.aborted
                    ? Effect.void
                    : Effect.sync(() => {
                        const previous = circuit.failures.get(key(model))
                        circuit.failures.set(key(model), { count: (previous?.count ?? 0) + 1, message: error.message })
                      }),
                ),
                Effect.tap(() => Effect.sync(() => circuit.failures.delete(key(model)))),
                Effect.map((result) => ({ model, result })),
              ),
        )
      const inference = yield* Effect.firstSuccessOf([attempt(first), ...candidates.slice(1).map(attempt)])

      return {
        title,
        output: inference.result.text,
        metadata: { model: key(inference.model), filePath: filepath },
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
