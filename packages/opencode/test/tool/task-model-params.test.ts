import { afterEach, beforeEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import path from "path"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
)

const it = testEffect(layer)

const taskModelPath = path.join(Global.Path.config, "task_model.json")

const taskModelConfig = {
  "test/never-model": { name: "Never Model", level: 0 },
  "test/cheap-model": { name: "Cheap Model", level: 1 },
  "test/mid-model": { name: "Mid Model", level: 2 },
  "test/best-model": { name: "Best Model", level: 3 },
}

const seed = Effect.fn("TaskModelTest.seed")(function* (title = "Test") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task model parameters", () => {
  it.instance("passes explicit model param to the subagent prompt", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "test model",
          prompt: "do something",
          subagent_type: "general",
          model: "anthropic/claude-sonnet-4",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.model).toEqual({
        modelID: ModelV2.ID.make("claude-sonnet-4"),
        providerID: ProviderV2.ID.make("anthropic"),
      })
      expect(seen?.variant).toBeUndefined()
    }),
  )

  it.instance("explicit model overrides agent configured model", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "override agent model",
          prompt: "do something",
          subagent_type: "general",
          model: "openai/gpt-5",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.model).toEqual({
        modelID: ModelV2.ID.make("gpt-5"),
        providerID: ProviderV2.ID.make("openai"),
      })
    }),
  )

  it.instance("falls back to parent model when no model or model_level is specified", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "default model",
          prompt: "do something",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.model).toEqual({
        modelID: ref.modelID,
        providerID: ref.providerID,
      })
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("model_level without task_model.json fall back to default model", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "model_level without config",
          prompt: "do something",
          subagent_type: "general",
          model_level: 2,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.model).toEqual({
        modelID: ref.modelID,
        providerID: ref.providerID,
      })
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("model_level is ignored when task_model is not enabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "model_level disabled",
          prompt: "do something",
          subagent_type: "general",
          model_level: 3,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.model).toEqual({
        modelID: ref.modelID,
        providerID: ref.providerID,
      })
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("task tool schema hides model and model_level when task_model is not enabled", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({ ...ref, agent: build })
      const taskTool = tools.find((tool) => tool.id === TaskTool.id)

      expect(taskTool?.jsonSchema).toBeDefined()
      const props = taskTool?.jsonSchema?.properties ?? {}
      expect("model" in props).toBe(false)
      expect("model_level" in props).toBe(false)
    }),
  )
})

describe("tool.task model_level with task_model.json", () => {
  let originalTaskModel: string | undefined

  beforeEach(async () => {
    const tmFile = Bun.file(taskModelPath)
    originalTaskModel = await tmFile.exists() ? await tmFile.text() : undefined
    await fs.writeFile(taskModelPath, JSON.stringify(taskModelConfig))
  })

  afterEach(async () => {
    if (originalTaskModel !== undefined) {
      await fs.writeFile(taskModelPath, originalTaskModel)
    } else {
      try { await fs.unlink(taskModelPath) } catch {}
    }
  })

  it.instance(
    "auto-selects a model based on model_level",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          {
            description: "auto-select model",
            prompt: "do something",
            subagent_type: "general",
            model_level: 3,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toBeDefined()
        expect(seen?.model?.providerID).toBe(ProviderV2.ID.make("test"))
        expect(seen?.model?.modelID).toBe(ModelV2.ID.make("best-model"))
        expect(seen?.variant).toBeUndefined()
      }),
    { config: { task_model: true } },
  )

  it.instance(
    "auto-selects cheapest model for level 1",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          {
            description: "level 1 model",
            prompt: "do something",
            subagent_type: "general",
            model_level: 1,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model?.modelID).toBe(ModelV2.ID.make("cheap-model"))
        expect(seen?.model?.providerID).toBe(ProviderV2.ID.make("test"))
      }),
    { config: { task_model: true } },
  )

  it.instance(
    "auto-selects default model for level 0 (never auto-select)",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          {
            description: "level 0 model",
            prompt: "do something",
            subagent_type: "general",
            model_level: 0,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toEqual({
          modelID: ref.modelID,
          providerID: ref.providerID,
        })
        expect(seen?.variant).toBe("xhigh")
      }),
    { config: { task_model: true } },
  )

  it.instance(
    "explicit model takes precedence over model_level",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          {
            description: "explicit over level",
            prompt: "do something",
            subagent_type: "general",
            model: "openai/gpt-5",
            model_level: 1,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toEqual({
          modelID: ModelV2.ID.make("gpt-5"),
          providerID: ProviderV2.ID.make("openai"),
        })
      }),
    { config: { task_model: true } },
  )

  it.instance(
    "task tool description includes task_model.json catalog",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({ ...ref, agent: build })
        const description = tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("Available task models:")
        expect(description).toContain("test/cheap-model: Cheap Model")
        expect(description).toContain("test/best-model: Best Model")
        expect(description).not.toContain("test/never-model")
      }),
    { config: { task_model: true } },
  )

  it.instance(
    "task tool schema includes model and model_level when task_model is enabled",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const tools = yield* registry.tools({ ...ref, agent: build })
        const taskTool = tools.find((tool) => tool.id === TaskTool.id)

        const props = taskTool?.jsonSchema?.properties ?? taskTool?.parameters
        expect("model" in (props as object)).toBe(true)
        expect("model_level" in (props as object)).toBe(true)
      }),
    { config: { task_model: true } },
  )

  it.instance(
    "rejects execution when task_model is enabled but neither model nor model_level is given",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const promptOps = stubOps()

        const exit = yield* def
          .execute(
            {
              description: "no model specified",
              prompt: "do something",
              subagent_type: "general",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
      }),
    { config: { task_model: true } },
  )
})
