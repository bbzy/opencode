import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import * as Scope from "effect/Scope"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt, loopConfig } from "../../src/session/prompt"
import { Loop } from "@/session/loop"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { instanceStoreStub, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Storage } from "@/storage/storage"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  Storage.node,
])

function makePrompt(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
    [InstanceStore.node, instanceStoreStub],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions)],
    [RuntimeFlags.node, runtimeFlags],
    [InstanceStore.node, instanceStoreStub],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits for a completed parent turn with nonmonotonic message IDs",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const userID = MessageID.make("msg_z_user")
      const assistantID = MessageID.make("msg_a_assistant")
      yield* sessions.updateMessage({
        id: userID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: 100 },
      })
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID: userID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: 200, completed: 201 },
        finish: "stop",
      })

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.id).toBe(assistantID)
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("loop continues when finish is unknown", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
}),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle second round is idle-anchored (fires interval after round ends, not wall-clock)",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()

        // Hold round 1's LLM response so the round takes ~500ms to complete.
        const gate = yield* Deferred.make<void>()
        yield* llm.hold("round 1", deferredAsPromise(gate))
        const beforeStart = yield* Clock.currentTimeMillis
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "start 100ms" })
        yield* llm.wait(1)
        // Round 1 is running; ticker defers because current.running.
        // Release the gate after a short delay so round 1 ends ~500ms after start.
        yield* Effect.sleep(Duration.millis(400))
        yield* Deferred.succeed(gate, void 0)
        // Wait for round 2's LLM call.
        yield* llm.wait(2)
        const afterRound2Call = yield* Clock.currentTimeMillis
        const elapsed = afterRound2Call - beforeStart
        // If wall-clock anchored, round 2 would fire ~100ms after start, so
        // elapsed would be ~500ms. With idle-anchored, round 2 fires ~100ms
        // after round 1 ends (~500ms after start), so elapsed should be ~600ms.
        expect(elapsed).toBeGreaterThanOrEqual(550)

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  10_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)

// ── completion marker ──────────────────────────────────────────────

const MARKER = "<response>complete</response>"
const MARKER_INSTRUCTION = `At the end of every response, you MUST append the exact string "${MARKER}" to indicate the response is complete.`

it.instance("completion marker: strips marker from displayed text", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "MarkerStrip",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      system: MARKER_INSTRUCTION,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world" + MARKER)

    const result = yield* prompt.loop({ sessionID: chat.id })
    const parts = result.parts.filter((p) => p.type === "text")
    const fullText = parts.map((p) => p.text).join("")
    expect(fullText).not.toContain(MARKER)
    expect(fullText).toBe("world")
    if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("completion marker: injects warning and continues when marker is missing", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "MarkerMissing",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      system: MARKER_INSTRUCTION,
      parts: [{ type: "text", text: "hello" }],
    })
    // First response: missing marker — should trigger warning + retry
    yield* llm.text("incomplete response")
    // Second response: has marker — should be accepted and stripped
    yield* llm.text("now complete" + MARKER)

    const result = yield* prompt.loop({ sessionID: chat.id })

    // Should have made 2 LLM calls
    expect(yield* llm.hits).toHaveLength(2)

    // Final response text should not contain marker
    const parts = result.parts.filter((p) => p.type === "text")
    const fullText = parts.map((p) => p.text).join("")
    expect(fullText).not.toContain(MARKER)
    expect(fullText).toBe("now complete")

    // Session should contain the injected warning message
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const warning = msgs.find(
      (msg) =>
        msg.info.role === "user" &&
        msg.parts.some(
          (p) => p.type === "text" && p.synthetic && (p as SessionV1.TextPart).text.includes("Auto-detection warning"),
        ),
    )
    expect(warning).toBeDefined()
  }),
)

it.instance("completion marker: retries when response is interrupted (finish=unknown)", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "UnknownFinish",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    // First response: finish=unknown — should trigger warning + retry
    yield* llm.push(reply().text("partial response").unknown())
    // Second response: finish=stop — should be accepted (no marker enforcement without opt-in)
    yield* llm.text("complete response")

    const result = yield* prompt.loop({ sessionID: chat.id })

    // Should have made 2 LLM calls
    expect(yield* llm.hits).toHaveLength(2)

    // Final response text should not contain marker
    const parts = result.parts.filter((p) => p.type === "text")
    const fullText = parts.map((p) => p.text).join("")
    expect(fullText).not.toContain(MARKER)
    expect(fullText).toBe("complete response")

    // Session should contain the injected warning message
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const warning = msgs.find(
      (msg) =>
        msg.info.role === "user" &&
        msg.parts.some(
          (p) => p.type === "text" && p.synthetic && (p as SessionV1.TextPart).text.includes("Auto-detection warning"),
        ),
    )
    expect(warning).toBeDefined()
  }),
)

it.instance("retries when finish=stop but response has reasoning with no text or tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "ReasoningStop",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    // First response: reasoning-only with finish=stop — should trigger retry
    yield* llm.push(reply().reason("I should check the task status").stop())
    // Second response: finish tool-calls — should continue normally
    yield* llm.text("complete response")

    const result = yield* prompt.loop({ sessionID: chat.id })

    // Should have made 2 LLM calls (retry happened)
    expect(yield* llm.hits).toHaveLength(2)

    // Final response text should be the second response
    const parts = result.parts.filter((p) => p.type === "text")
    const fullText = parts.map((p) => p.text).join("")
    expect(fullText).toBe("complete response")

    // Session should contain the injected warning message
    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const warning = msgs.find(
      (msg) =>
        msg.info.role === "user" &&
        msg.parts.some(
          (p) =>
            p.type === "text" &&
            p.synthetic &&
            (p as SessionV1.TextPart).text.includes("stopped while still in reasoning"),
        ),
    )
    expect(warning).toBeDefined()
  }),
)

// /cycle command

noLLMServer.instance(
  "/cycle start returns cycle started message",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: 'start 5m',
      })
      expect(result.info.role).toBe("user")
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("Cycle started: every 5m")
      yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
    }),
  { config: cfg },
)

it.instance(
  "/cycle coalesces ticks while a round is running",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 50
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        const gate = yield* Deferred.make<void>()
        yield* llm.hold("first", deferredAsPromise(gate))
        yield* llm.text("second")
        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: '100ms',
        })
        yield* llm.wait(1)
        yield* Effect.sleep(Duration.millis(350))
        yield* Deferred.succeed(gate, void 0)
        yield* llm.wait(2)
        const callsAfterSecond = yield* llm.calls
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
        expect(callsAfterSecond).toBe(2)
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "/cycle replaces the active cycle when a new one is started",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: 'start 5m',
      })
      const replaced = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: 'start 10m',
      })
      const text = (replaced.parts.find((part) => part.type === "text") as SessionV1.TextPart)?.text ?? ""
      expect(text).toContain("Cycle started: every 10m")
      expect(text).toContain("replaced previous cycle")
      const state = (yield* prompt.loopState())[chat.id]
      expect(state.intervalStr).toBe("every 10m")
      yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle status shows active cycle",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: 'start 10m',
      })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "status",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("Cycle active: every 10m")
      yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle state is isolated by session",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const first = yield* sessions.create({ title: "First Cycle" })
      const second = yield* sessions.create({ title: "Second Cycle" })
      yield* prompt.command({
        sessionID: first.id,
        command: "cycle",
        arguments: 'start 5m',
      })
      yield* prompt.command({
        sessionID: second.id,
        command: "cycle",
        arguments: 'start 10m',
      })
      yield* prompt.command({ sessionID: first.id, command: "cycle", arguments: "stop" })
      const storage = yield* Storage.Service
      expect((yield* Loop.readPersistedState(storage, first.id)).type).toBe("missing")
      expect((yield* Loop.readPersistedState(storage, second.id)).type).toBe("found")
      const status = yield* prompt.command({ sessionID: second.id, command: "cycle", arguments: "status" })
      expect((status.parts.find((part) => part.type === "text") as SessionV1.TextPart)?.text).toContain("Cycle active")
      yield* prompt.command({ sessionID: second.id, command: "cycle", arguments: "stop" })
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle stop returns rounds count",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: 'start 5m',
      })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "stop",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("Cycle stopped")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle stop with no active cycle returns message",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "stop",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("No active cycle")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle status with no active cycle returns message",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "status",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("No active cycle")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle start with missing interval returns usage",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "start",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("Usage: /cycle")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle start with invalid interval returns error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: 'start invalid',
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("Invalid interval")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle start with no prompt starts a bare cycle",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "start 5m",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("Cycle started")
      yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle start rejects interval below minimum",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: 'start 5s',
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("Minimum interval is 30s")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle with no arguments shows full help",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("Usage: /cycle")
      expect((text as SessionV1.TextPart)?.text).toContain("Subcommands:")
      expect((text as SessionV1.TextPart)?.text).toContain("start")
      expect((text as SessionV1.TextPart)?.text).toContain("stop")
      expect((text as SessionV1.TextPart)?.text).toContain("pause")
      expect((text as SessionV1.TextPart)?.text).toContain("resume")
      expect((text as SessionV1.TextPart)?.text).toContain("status")
      expect((text as SessionV1.TextPart)?.text).toContain("Examples:")
      expect((text as SessionV1.TextPart)?.text).toContain("Intervals:")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle help shows full help",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "help",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("Usage: /cycle")
      expect((text as SessionV1.TextPart)?.text).toContain("Examples:")
    }),
  { config: cfg },
)

it.instance(
  "/cycle start sends prompts at intervals",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })

        yield* llm.wait(3)
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })

        expect(yield* llm.calls).toBeGreaterThanOrEqual(3)

        const inputs = yield* llm.inputs
        const lastInput = inputs.at(-1)
        expect(JSON.stringify(lastInput)).toContain("[Cycle #")
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle first execution runs immediately",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 500ms',
        })

        yield* llm.wait(1)
        expect(yield* llm.calls).toBe(1)
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })

        expect(yield* llm.calls).toBeGreaterThanOrEqual(1)
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "/cycle pause and resume preserve round count",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: 'start 5m',
      })

      const pauseResult = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "pause",
      })
      const pauseText = pauseResult.parts.find((p) => p.type === "text")
      expect((pauseText as SessionV1.TextPart)?.text).toContain("Cycle paused")

      const statusResult = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "status",
      })
      const statusText = statusResult.parts.find((p) => p.type === "text")
      expect((statusText as SessionV1.TextPart)?.text).toContain("paused")

      const resumeResult = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "resume",
      })
      const resumeText = resumeResult.parts.find((p) => p.type === "text")
      expect((resumeText as SessionV1.TextPart)?.text).toContain("Cycle resumed")

      yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle pause with no active cycle returns message",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "pause",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("No active cycle")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle resume with no active cycle returns message",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "resume",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("No active cycle")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle pause twice returns already paused",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: 'start 5m',
      })
      yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "pause" })
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "cycle",
        arguments: "pause",
      })
      const text = result.parts.find((p) => p.type === "text")
      expect((text as SessionV1.TextPart)?.text).toContain("already paused")
      yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
    }),
  { config: cfg },
)



it.instance(
  "/cycle auto-stops after max consecutive failures",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      const originalMax = loopConfig.maxConsecutiveFailures
      loopConfig.minIntervalMs = 100
      loopConfig.maxConsecutiveFailures = 3
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.fail("boom")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })

        yield* llm.wait(3)

        expect(yield* llm.calls).toBeGreaterThanOrEqual(3)

        const inputs = yield* llm.inputs
        const lastInput = inputs.at(-1)
        expect(JSON.stringify(lastInput)).toContain("[Cycle #")
      } finally {
        loopConfig.minIntervalMs = originalMin
        loopConfig.maxConsecutiveFailures = originalMax
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle pauses after max dry iterations and status shows idle retries",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      const originalMaxDry = loopConfig.maxDryIterations
      loopConfig.minIntervalMs = 100
      loopConfig.maxDryIterations = 2
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("no file changes here")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })

        yield* llm.wait(2)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            return stateMap[chat.id]?.paused ? (true as const) : undefined
          }),
          "loop never paused after dry iterations",
          "10 seconds",
        )

        const statusResult = yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: "status",
        })
        const statusText = (statusResult.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(statusText).toContain("paused after 2 idle retries")

        const stateMap = yield* prompt.loopState()
        const state = stateMap[chat.id]
        expect(state.paused).toBe(true)
        expect(state.consecutiveDry).toBe(2)

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
        loopConfig.maxDryIterations = originalMaxDry
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "recovered loop rounds run with the session instance context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { chat } = yield* boot()
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      yield* llm.text("recovered round")
      const now = Date.now()
      yield* Loop.persistLoopState(storage, chat.id, {
        version: 1,
        intervalStr: "every 100ms",
        schedule: { type: "cycle", intervalMs: 100 },
        rounds: 4,
        startedAt: now - 120_000,
        nextRunAt: now - 1_000,
        paused: false,
        pending: false,
        running: false,
        consecutiveFailures: 0,
        consecutiveDry: 0,
        consecutiveEmpty: 0,
        coalescedCount: 0,
        timezone: "local",
        commandSeq: 0,
      })
      // Simulate a server restart: rebuild the prompt graph with a fresh memo
      // map so recovery runs again at layer init, sharing only this test's
      // database (a fully isolated :memory: build would not see the session).
      // Without the instance context on the recovered fiber, the round dies in
      // Agent.defaultInfo ("InstanceRef not provided") before any LLM call.
      const inner = LayerNode.compile(promptRoot, [
        [SessionSummary.node, summary],
        [LSP.node, lsp],
        [MCP.node, makeMcp()],
        [RuntimeFlags.node, runtimeFlags],
        [InstanceStore.node, instanceStoreStub],
        [Database.node, Layer.succeed(Database.Service, database)],
      ])
      const memo = yield* Layer.makeMemoMap
      const scope = yield* Scope.make()
      yield* Effect.gen(function* () {
        yield* Layer.buildWithMemoMap(inner, memo, scope)
        yield* llm.wait(1)
      }).pipe(
        // Server startup runs recovery with no ambient instance; mask the test
        // body's InstanceRef so a missing provide in recovery is observable.
        Effect.provideService(InstanceRef, undefined),
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.ensuring(Loop.clearPersistedState(storage, chat.id).pipe(Effect.ignore)),
      )
    }),
  { config: cfg },
  30_000,
)

const foreignLoopState = (now: number): Loop.SerializedLoopState => ({
  version: 1,
  intervalStr: "every 5m",
  schedule: { type: "cycle", intervalMs: 300_000 },
  rounds: 4,
  startedAt: now - 600_000,
  nextRunAt: now + 300_000,
  paused: false,
  pending: false,
  running: false,
  consecutiveFailures: 0,
  consecutiveDry: 0,
  consecutiveEmpty: 0,
  coalescedCount: 0,
  timezone: "local",
  owner: { id: "other-process", at: now },
  commandSeq: 2,
})

noLLMServer.instance(
  "/cycle stop clears a loop owned by another process",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      yield* Loop.persistLoopState(storage, chat.id, foreignLoopState(Date.now()))
      const result = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      const text = (result.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
      expect(text).toContain("another process")
      expect((yield* Loop.readPersistedState(storage, chat.id)).type).toBe("missing")
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle status reports a loop owned by another process",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      yield* Loop.persistLoopState(storage, chat.id, foreignLoopState(Date.now()))
      const result = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "status" })
      const text = (result.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
      expect(text).toContain("Cycle active in another process: every 5m, 4 rounds completed")
      yield* Loop.clearPersistedState(storage, chat.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "/cycle pause and resume mutate a loop owned by another process",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const chat = yield* sessions.create({ title: "Cycle" })
      yield* Loop.persistLoopState(storage, chat.id, foreignLoopState(Date.now()))

      const paused = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "pause" })
      const pausedText = (paused.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
      expect(pausedText).toContain("another process")
      const afterPause = yield* Loop.readPersistedState(storage, chat.id)
      expect(afterPause.type).toBe("found")
      if (afterPause.type === "found") {
        expect(afterPause.state.paused).toBe(true)
        expect(afterPause.state.commandSeq).toBe(3)
      }

      const resumed = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "resume" })
      const resumedText = (resumed.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
      expect(resumedText).toContain("another process")
      const afterResume = yield* Loop.readPersistedState(storage, chat.id)
      expect(afterResume.type).toBe("found")
      if (afterResume.type === "found") {
        expect(afterResume.state.paused).toBe(false)
        expect(afterResume.state.commandSeq).toBe(4)
      }
      yield* Loop.clearPersistedState(storage, chat.id)
    }),
  { config: cfg },
)

it.instance(
  "a coalesced cycle round leaves no stray prompt behind",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      const gate = yield* Deferred.make<void>()
      yield* llm.hold("first round", deferredAsPromise(gate))
      const first = yield* prompt
        .loopRun({
          sessionID: chat.id,
          model: ref,
          parts: [{ type: "text", text: "[Cycle #1] Automated cycle — iteration 1." }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      // The session drain is held by the first round: a second loopRun must
      // fail busy without admitting its "[Cycle #N]" user message.
      const busy = yield* prompt
        .loopRun({
          sessionID: chat.id,
          model: ref,
          parts: [{ type: "text", text: "[Cycle #2] Automated cycle — iteration 2." }],
        })
        .pipe(
          Effect.map(() => "ran" as const),
          Effect.catchTag("SessionBusyError", () => Effect.succeed("busy" as const)),
        )
      expect(busy).toBe("busy")
      yield* Deferred.succeed(gate, void 0)
      yield* Fiber.await(first)
      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const cyclePrompts = msgs.filter(
        (msg) =>
          msg.info.role === "user" &&
          msg.parts.some((part) => part.type === "text" && part.text.includes("[Cycle #")),
      )
      expect(cyclePrompts).toHaveLength(1)
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "an auto-paused cycle fires no further rounds",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      const originalMaxDry = loopConfig.maxDryIterations
      loopConfig.minIntervalMs = 100
      loopConfig.maxDryIterations = 1
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("no file changes")
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "start 100ms" })
        yield* llm.wait(1)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            return stateMap[chat.id]?.paused ? (true as const) : undefined
          }),
          "loop never paused after a dry iteration",
          "10 seconds",
        )
        // The sleep is the test: a paused cycle must stay quiet instead of
        // firing a pending scheduled tick seconds after the pause.
        yield* Effect.sleep(Duration.millis(500))
        expect(yield* llm.calls).toBe(1)
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
        loopConfig.maxDryIterations = originalMaxDry
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "round prompts carry the previous round summary and idle status",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("fixed the widget")
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "start 100ms" })
        yield* llm.wait(2)
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const round2 = msgs.find(
          (msg) =>
            msg.info.role === "user" &&
            msg.parts.some((part) => part.type === "text" && part.text.includes("[Cycle #2]")),
        )
        const text = round2?.parts.find((part) => part.type === "text")
        expect(text?.type).toBe("text")
        if (text?.type !== "text") return
        expect(text.text).toContain("Last completed iteration: #1 — fixed the widget")
        expect(text.text).toContain("Idle status: 1/3")
        expect(text.text).toContain("duplicate delivery")
        expect(text.text).toContain("DONE")
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cycle auto-stops after consecutive empty provider responses",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        const storage = yield* Storage.Service
        // Finish "stop" with no content and zero tokens: the provider is
        // broken, so the cycle must stop fast instead of pausing on dry.
        // Two replies, one per round — the queue is consumed per request.
        yield* llm.push(reply().stop(), reply().stop())
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "start 100ms" })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            return stateMap[chat.id] === undefined ? (true as const) : undefined
          }),
          "cycle never auto-stopped after empty responses",
          "10 seconds",
        )
        expect((yield* Loop.readPersistedState(storage, chat.id)).type).toBe("missing")
        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const stopMsg = msgs.find(
          (msg) =>
            msg.info.role === "user" &&
            msg.parts.some((part) => part.type === "text" && part.text.includes("empty responses")),
        )
        expect(stopMsg).toBeDefined()
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "scheduler exits quietly when another process takes over the ownership lease",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        const storage = yield* Storage.Service
        yield* llm.text("round")
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "start 100ms" })
        yield* llm.wait(1)
        // Another process takes over: foreign owner with a bumped commandSeq.
        // Re-assert it on every poll so a renewal racing the write cannot
        // clobber the takeover back.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            if (stateMap[chat.id] === undefined) return true as const
            const persisted = yield* Loop.readPersistedState(storage, chat.id)
            if (persisted.type === "found" && persisted.state.owner?.id !== "other-process") {
              yield* Loop.persistLoopState(storage, chat.id, {
                ...persisted.state,
                owner: { id: "other-process", at: Date.now() },
                commandSeq: persisted.state.commandSeq + 1,
              })
            }
            return undefined
          }),
          "scheduler did not exit after losing ownership",
          "10 seconds",
        )
        // The loser must not clobber the new owner's persisted state.
        const after = yield* Loop.readPersistedState(storage, chat.id)
        expect(after.type).toBe("found")
        if (after.type === "found") expect(after.state.owner?.id).toBe("other-process")
        yield* Loop.clearPersistedState(storage, chat.id)
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cross-process resume is adopted at the next tick",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        const storage = yield* Storage.Service
        yield* llm.text("round")
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "start 100ms" })
        yield* llm.wait(1)
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "pause" })
        // Simulate a resume issued from another opencode process. Re-assert it
        // on every poll so a ticker renewal racing the write cannot clobber it.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const calls = yield* llm.calls
            if (calls >= 2) return true as const
            const persisted = yield* Loop.readPersistedState(storage, chat.id)
            if (persisted.type === "found" && persisted.state.paused) {
              yield* Loop.persistLoopState(storage, chat.id, {
                ...persisted.state,
                paused: false,
                consecutiveDry: 0,
                consecutiveFailures: 0,
                nextRunAt: Date.now(),
                commandSeq: persisted.state.commandSeq + 1,
              })
            }
            return undefined
          }),
          "cross-process resume was never adopted",
          "10 seconds",
        )
        const stateMap = yield* prompt.loopState()
        expect(stateMap[chat.id]?.paused).toBe(false)
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle status shows consecutive dry count before pause",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      const originalMaxDry = loopConfig.maxDryIterations
      loopConfig.minIntervalMs = 100
      loopConfig.maxDryIterations = 5
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("no file changes")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })

        yield* llm.wait(1)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            return stateMap[chat.id]?.consecutiveDry === 1 ? (true as const) : undefined
          }),
          "loop never recorded first dry iteration",
          "10 seconds",
        )

        const statusResult = yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: "status",
        })
        const statusText = (statusResult.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(statusText).toContain("1/5 consecutive idle iterations")

        const stateMap = yield* prompt.loopState()
        const state = stateMap[chat.id]
        expect(state.consecutiveDry).toBe(1)
        expect(state.paused).toBe(false)

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
        loopConfig.maxDryIterations = originalMaxDry
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle does not count apply_patch rounds as dry",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        // apply_patch is only registered for gpt-* models (edit/write are
        // disabled for those), so this test needs a gpt-* model config.
        const patchCfg = (url: string) => ({
          ...providerCfg(url),
          provider: {
            ...cfg.provider,
            test: {
              ...cfg.provider.test,
              options: { ...cfg.provider.test.options, baseURL: url },
              models: {
                "gpt-5": { ...cfg.provider.test.models["test-model"], id: "gpt-5", name: "GPT-5" },
              },
            },
          },
          model: "test/gpt-5",
        })
        const { llm } = yield* useServerConfig(patchCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "apply_patch cycle",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.tool("apply_patch", {
          patchText: "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch",
        })
        yield* llm.text("added")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 2 ? (true as const) : undefined
          }),
          "cycle never completed two rounds",
          "10 seconds",
        )

        // Round 1 modified a file via apply_patch (dry resets), round 2 got the
        // auto "ok" response with no tools (dry increments to exactly 1).
        const dry = (yield* prompt.loopState())[chat.id].consecutiveDry
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
        expect(dry).toBe(1)
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle ticks while paused do not inflate coalesced count",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("ok")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 1 ? (true as const) : undefined
          }),
          "cycle never completed a round",
          "10 seconds",
        )

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "pause" })
        const coalesced = (yield* prompt.loopState())[chat.id].coalescedCount
        // The sleep is the test: several scheduled ticks pass while paused and
        // must not be counted as coalesced.
        yield* Effect.sleep(Duration.millis(550))

        expect((yield* prompt.loopState())[chat.id].coalescedCount).toBe(coalesced)

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle run while paused says to resume first",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("ok")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 1 ? (true as const) : undefined
          }),
          "cycle never completed a round",
          "10 seconds",
        )
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "pause" })

        const runResult = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "run" })
        const runText = (runResult.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(runText).toContain("Cycle is paused")

        const resumeResult = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "resume" })
        const resumeText = (resumeResult.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(resumeText).toContain("Cycle resumed; a run is starting now.")

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle runs rounds on an idle-anchored interval",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("no file changes")

        const started = yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })
        const startedText = (started.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(startedText).toContain("Cycle started: every 200ms")

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 2 ? (true as const) : undefined
          }),
          "cycle never completed two rounds",
          "10 seconds",
        )

        const stateMap = yield* prompt.loopState()
        expect(stateMap[chat.id].mode).toBe("cycle")

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle defers while the session is busy and does not coalesce ticks",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()

        const gate = yield* Deferred.make<void>()
        yield* llm.hold("user work", deferredAsPromise(gate))
        const userRun = yield* prompt
          .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "work" }] })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: '300ms' })
        // The sleep is the test: the first tick passes while the session is
        // busy and must defer without counting as coalesced.
        yield* Effect.sleep(Duration.millis(450))
        const during = (yield* prompt.loopState())[chat.id]
        expect(during.rounds).toBe(0)
        expect(during.coalescedCount).toBe(0)

        yield* Deferred.succeed(gate, void 0)
        yield* Fiber.await(userRun)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 1 ? (true as const) : undefined
          }),
          "cycle never ran after the session went idle",
          "10 seconds",
        )

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle pauses when the user aborts a round",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()

        const started = yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })
        const startedText = (started.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(startedText).toContain("Cycle started: every 200ms")

        // Hold the first round's LLM response so the abort lands mid-round.
        const gate = yield* Deferred.make<void>()
        yield* llm.hold("held round", deferredAsPromise(gate))
        yield* waitForBusy(chat.id)
        yield* prompt.cancel(chat.id)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const state = (yield* prompt.loopState())[chat.id]
            return state && state.rounds >= 1 && state.paused ? (true as const) : undefined
          }),
          "cycle never paused after the aborted round",
          "10 seconds",
        )

        // The abort is a skip, not a failure, and no further rounds fire while paused.
        yield* Deferred.succeed(gate, void 0)
        yield* Effect.sleep(Duration.millis(500))
        const during = (yield* prompt.loopState())[chat.id]
        expect(during.rounds).toBe(1)
        expect(during.consecutiveFailures).toBe(0)

        yield* llm.text("resumed round")
        const resumed = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "resume" })
        const resumedText = (resumed.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(resumedText).toContain("Cycle resumed; a run is starting now.")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const state = (yield* prompt.loopState())[chat.id]
            return state && state.rounds >= 2 ? (true as const) : undefined
          }),
          "cycle never ran after resume",
          "10 seconds",
        )

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle starting a new cycle overwrites the active one",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      yield* llm.text("ok")

      yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: 'start 5m' })

      const replaced = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: 'start 3m' })
      const replacedText = (replaced.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
      expect(replacedText).toContain("Cycle started: every 3m")
      expect(replacedText).toContain("replaced previous cycle")
      expect((yield* prompt.loopState())[chat.id].mode).toBe("cycle")

      yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      expect((yield* prompt.loopState())[chat.id]).toBeUndefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle pause, status, run, and resume round-trip",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      const originalMaxDry = loopConfig.maxDryIterations
      loopConfig.minIntervalMs = 100
      loopConfig.maxDryIterations = 10
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("no file changes")

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: '200ms' })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 1 ? (true as const) : undefined
          }),
          "cycle never completed a round",
          "10 seconds",
        )
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "pause" })

        const status = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "status" })
        const statusText = (status.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(statusText).toContain("Cycle active: every 200ms (paused)")

        const run = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "run" })
        const runText = (run.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(runText).toContain("Cycle is paused")

        const before = (yield* prompt.loopState())[chat.id].rounds
        const resume = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "resume" })
        const resumeText = (resume.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
        expect(resumeText).toContain("Cycle resumed; a run is starting now.")

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds > before ? (true as const) : undefined
          }),
          "cycle never ran after resume",
          "10 seconds",
        )

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
        loopConfig.maxDryIterations = originalMaxDry
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle pauses after max dry iterations",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      const originalMaxDry = loopConfig.maxDryIterations
      loopConfig.minIntervalMs = 100
      loopConfig.maxDryIterations = 2
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("no file changes")

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: '200ms' })

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            return stateMap[chat.id]?.paused ? (true as const) : undefined
          }),
          "cycle never paused after dry iterations",
          "10 seconds",
        )

        const state = (yield* prompt.loopState())[chat.id]
        expect(state.consecutiveDry).toBe(2)
        expect(state.mode).toBe("cycle")

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
        loopConfig.maxDryIterations = originalMaxDry
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle rejects clock-time schedules",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      yield* llm.text("ok")

      const at = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: 'at 14:00' })
      const atText = (at.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
      expect(atText).toContain("Cycles only support intervals")

      const startAt = yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: 'start at 14:00' })
      const startAtText = (startAt.parts.find((p) => p.type === "text") as SessionV1.TextPart)?.text ?? ""
      expect(startAtText).toContain("Cycles only support intervals")

      expect((yield* prompt.loopState())[chat.id]).toBeUndefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle skip on busy does not send messages to transcript",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.hang

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })

        yield* llm.wait(1)
        yield* Effect.sleep(Duration.millis(500))

        const messages = yield* (yield* Session.Service).messages({ sessionID: chat.id, limit: 100 })
        const skipMessages = messages.filter(
          (m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text.includes("Skipped")),
        )
        expect(skipMessages.length).toBe(0)

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)



it.instance(
  "/cycle restart keeps cycle alive after first scheduled run",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })
        yield* llm.wait(1)

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: '200ms',
        })

        yield* llm.wait(3)

        const stateMap = yield* prompt.loopState()
        expect(stateMap[chat.id]).toBeDefined()
        expect(stateMap[chat.id].paused).toBe(false)

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle resume keeps cycle alive after next scheduled run",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      const originalMaxDry = loopConfig.maxDryIterations
      loopConfig.minIntervalMs = 100
      loopConfig.maxDryIterations = 2
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("no file changes")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })

        yield* llm.wait(2)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const s = yield* prompt.loopState()
            return s[chat.id]?.paused ? (true as const) : undefined
          }),
          "cycle never paused",
          "10 seconds",
        )

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: "resume",
        })

        yield* llm.wait(3)

        const stateMap = yield* prompt.loopState()
        expect(stateMap[chat.id]).toBeDefined()
        expect(stateMap[chat.id].paused).toBe(false)

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "persisted cycle state decodes with defaults for fields added later",
  () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "recover" })
      const now = Date.now()
      // consecutiveDry deliberately omitted: persisted states written before
      // the field existed must decode through the withDecodingDefaultKey(0)
      // fallback instead of being discarded as invalid.
      yield* storage
        .write(["loop", chat.id, "state"], {
          version: 1,
          intervalStr: "every 5m",
          schedule: { type: "cycle", intervalMs: 300_000 },
          rounds: 7,
          startedAt: now - 60_000,
          nextRunAt: now + 300_000,
          paused: false,
          pending: false,
          running: false,
          consecutiveFailures: 0,
          coalescedCount: 0,
          timezone: "local",
        })
        .pipe(Effect.orDie)

      const recovered = yield* Loop.readPersistedState(storage, chat.id)
      expect(recovered.type).toBe("found")
      if (recovered.type !== "found") return
      expect(recovered.state.consecutiveDry).toBe(0)
      expect(recovered.state.rounds).toBe(7)
      expect(Loop.scheduleMode()).toBe("cycle")
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle user abort pauses the cycle without counting a failure",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      const originalMaxDry = loopConfig.maxDryIterations
      loopConfig.minIntervalMs = 100
      loopConfig.maxDryIterations = 10
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("first ok")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 500ms',
        })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 1 ? (true as const) : undefined
          }),
          "cycle never completed its first round",
          "10 seconds",
        )

        // Round 2 hangs mid-stream and gets aborted by the user; the cycle must
        // pause instead of firing round 3. llm.wait(2) proves round 2's request
        // actually consumed the hung response before we abort — cancelling on
        // waitForBusy alone races the request and would leave the hang queued
        // for the next round to consume.
        yield* llm.hang
        yield* llm.wait(2)
        yield* prompt.cancel(chat.id)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 2 && state.paused ? (true as const) : undefined
          }),
          "cycle never paused after the aborted round",
          "15 seconds",
        )

        const state = (yield* prompt.loopState())[chat.id]
        expect(state.consecutiveFailures).toBe(0)

        const texts = (yield* MessageV2.filterCompactedEffect(chat.id))
          .flatMap((msg) => msg.parts)
          .filter((part) => part.type === "text")
          .map((part) => part.text)
        expect(texts.some((text) => text.includes("Iteration failed"))).toBe(false)

        // Resume fires the next round immediately.
        yield* llm.text("after resume")
        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "resume" })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 3 ? (true as const) : undefined
          }),
          "cycle never continued after resume",
          "15 seconds",
        )

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
        loopConfig.maxDryIterations = originalMaxDry
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle stops when its session is deleted",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat, sessions } = yield* boot()
        yield* llm.text("ok")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            const state = stateMap[chat.id]
            return state && state.rounds >= 1 ? (true as const) : undefined
          }),
          "cycle never completed a round",
          "10 seconds",
        )

        yield* sessions.remove(chat.id)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const stateMap = yield* prompt.loopState()
            return stateMap[chat.id] === undefined ? (true as const) : undefined
          }),
          "cycle never stopped after its session was deleted",
          "10 seconds",
        )
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle restart with failing LLM does not cancel cycle",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      const originalMaxFailures = loopConfig.maxConsecutiveFailures
      loopConfig.minIntervalMs = 100
      loopConfig.maxConsecutiveFailures = 10
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        yield* llm.text("first ok")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })
        yield* llm.wait(1)

        yield* llm.fail("boom")
        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: '200ms',
        })

        yield* llm.wait(2)

        const stateMap = yield* prompt.loopState()
        expect(stateMap[chat.id]).toBeDefined()

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
        loopConfig.maxConsecutiveFailures = originalMaxFailures
      }
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "/cycle restart while old round is running does not cancel new cycle",
  () =>
    Effect.gen(function* () {
      const originalMin = loopConfig.minIntervalMs
      loopConfig.minIntervalMs = 100
      try {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()

        const gate = yield* Deferred.make<void>()
        yield* llm.hold("first", deferredAsPromise(gate))
        yield* llm.text("second")
        yield* llm.text("third")

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: 'start 200ms',
        })
        yield* llm.wait(1)

        yield* prompt.command({
          sessionID: chat.id,
          command: "cycle",
          arguments: '200ms',
        })

        yield* Deferred.succeed(gate, void 0)

        yield* llm.wait(3)

        const stateMap = yield* prompt.loopState()
        expect(stateMap[chat.id]).toBeDefined()
        expect(stateMap[chat.id].paused).toBe(false)

        yield* prompt.command({ sessionID: chat.id, command: "cycle", arguments: "stop" })
      } finally {
        loopConfig.minIntervalMs = originalMin
      }
    }),
  { config: cfg },
  30_000,
)
