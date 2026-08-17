import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MockLanguageModelV3 } from "ai/test"
import { Cause, Effect } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const providerID = ProviderV2.ID.make("vision")
const first = ProviderTest.model({
  id: ModelV2.ID.make("first"),
  providerID,
  capabilities: {
    ...ProviderTest.model().capabilities,
    attachment: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
  },
})
const second = ProviderTest.model({ ...first, id: ModelV2.ID.make("second") })
const calls: string[] = []
let secondSucceeds = true
const failed = new MockLanguageModelV3({
  provider: providerID,
  modelId: first.id,
  doGenerate: async () => {
    throw new Error("vision unavailable")
  },
})
const fallback = new MockLanguageModelV3({
  provider: providerID,
  modelId: second.id,
  doGenerate: async () => {
    if (!secondSucceeds) throw new Error("fallback unavailable")
    return {
      content: [{ type: "text" as const, text: "fallback result" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }
  },
})
const info = ProviderTest.info({ models: { [first.id]: first, [second.id]: second } }, first)
const provider = ProviderTest.fake({
  model: first,
  info,
  getModel: (requestedProviderID, modelID) => {
    const model = requestedProviderID === providerID ? info.models[modelID] : undefined
    return model
      ? Effect.succeed(model)
      : Effect.die(new Error(`Unknown test model: ${requestedProviderID}/${modelID}`))
  },
  getLanguage: (model) => {
    calls.push(model.id)
    return Effect.succeed(model.id === first.id ? failed : fallback)
  },
})
const withVisionModels = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [
      Config.node,
      TestConfig.layer({
        get: () => Effect.succeed({ image_models: [`${providerID}/${first.id}`, `${providerID}/${second.id}`] }),
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
      }),
    ],
    [Provider.node, provider.layer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

afterEach(async () => {
  calls.length = 0
  secondSucceeds = true
  await disposeAllInstances()
})

withVisionModels.instance("view_image falls back and fails fast after every configured model trips", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agent = yield* Agent.Service
    const currentAgent = yield* agent.defaultInfo()
    const tool = (yield* registry.tools({ providerID, modelID: first.id, agent: currentAgent })).find(
      (candidate) => candidate.id === "view_image",
    )
    expect(tool).toBeDefined()
    if (!tool) return

    const instance = yield* InstanceState.context
    const filePath = path.join(instance.directory, "pixel.png")
    yield* Effect.promise(() =>
      Bun.write(
        filePath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      ),
    )
    const context = {
      sessionID: SessionID.make("ses_view-image"),
      messageID: MessageID.ascending(),
      agent: currentAgent.name,
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }

    const result = yield* tool.execute({ filePath }, context)
    expect(result.output).toBe("fallback result")
    expect(result.metadata.model).toBe(`${providerID}/${second.id}`)
    expect(calls).toEqual([first.id, second.id])

    secondSucceeds = false
    yield* Effect.exit(tool.execute({ filePath }, context))
    expect(calls).toEqual([first.id, second.id, second.id, first.id])
    yield* Effect.exit(tool.execute({ filePath }, context))
    expect(calls).toEqual([first.id, second.id, second.id, first.id, second.id])

    const fastFailure = yield* Effect.exit(tool.execute({ filePath }, context))
    expect(calls).toEqual([first.id, second.id, second.id, first.id, second.id])
    expect(fastFailure._tag).toBe("Failure")
    if (fastFailure._tag === "Failure") {
      expect(Cause.pretty(fastFailure.cause)).toContain("All configured image_models are disabled")
    }
  }),
)
