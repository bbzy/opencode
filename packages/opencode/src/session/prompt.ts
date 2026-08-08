import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { type Tool as AITool, tool, jsonSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { MAX_STEPS_PROMPT } from "@opencode-ai/core/session/runner/max-steps"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "../mcp"
import { LSP } from "@/lsp/lsp"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Context,
  Schema,
  Stream,
  Types,
} from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { SessionRunState } from "./run-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { eq } from "drizzle-orm"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionReminders } from "./reminders"
import { SessionTools } from "./tools"
import { Loop } from "./loop"
import { LoopEvent } from "@opencode-ai/schema/loop-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { LLMEvent } from "@opencode-ai/llm"
import { Storage } from "@/storage/storage"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const FILE_MODIFY_TOOLS = new Set(["edit", "write", "apply_patch"])

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export const COMPLETION_MARKER = "<response>complete</response>"
export const COMPLETION_MARKER_INSTRUCTION = `At the end of every response, you MUST append the exact string "${COMPLETION_MARKER}" to indicate the response is complete. Do not include this marker anywhere else in your response.`
export const COMPLETION_MARKER_MISSING_WARNING =
  'Auto-detection warning: the response does not end with "<response>complete</response>". The response may be incomplete — it may have been interrupted or truncated. Please confirm whether the response was cut off and continue if needed.'
export const COMPLETION_INTERRUPTED_WARNING =
  "Auto-detection warning: the response was interrupted (finish reason: unknown). The response may be incomplete. Please continue from where you left off."
export const REASONING_STOP_WARNING =
  "Auto-detection warning: the response was stopped while still in reasoning, without producing visible output or tool calls. The response may be incomplete. Please continue from where you left off."

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatMcpResourceBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  // cleanup() marks abandoned tool_use blocks this way after retries/aborts.
  // They are not pending work and must not trigger an assistant-prefill request.
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly loopRun: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error | Session.BusyError>
  readonly loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  readonly loopState: () => Effect.Effect<Record<string, LoopEvent.LoopState>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const processor = yield* SessionProcessor.Service
    const compaction = yield* SessionCompaction.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const storage = yield* Storage.Service
    const instanceStore = yield* InstanceStore.Service
    const { db } = database
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      return {
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input).pipe(Effect.catch(Effect.die)),
      } satisfies TaskPromptOps
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
      task: SessionV1.SubtaskPart
      model: Provider.Model
      lastUser: SessionV1.User
      sessionID: SessionID
      session: Session.Info
      msgs: SessionV1.WithParts[]
    }) {
      const { task, model, lastUser, sessionID, session, msgs } = input
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops()
      const { task: taskTool } = yield* registry.named()
      const taskModel = task.model ? yield* getModel(task.model.providerID, task.model.modelID, sessionID) : model
      const assistantMessage: SessionV1.Assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: lastUser.id,
        sessionID,
        mode: task.agent,
        agent: task.agent,
        variant: lastUser.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: taskModel.id,
        providerID: taskModel.providerID,
        time: { created: Date.now() },
      })
      let part: SessionV1.ToolPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantMessage.id,
        sessionID: assistantMessage.sessionID,
        type: "tool",
        callID: ulid(),
        tool: TaskTool.id,
        state: {
          status: "running",
          input: {
            prompt: task.prompt,
            description: task.description,
            subagent_type: task.agent,
            command: task.command,
          },
          time: { start: Date.now() },
        },
      })
      const taskArgs = {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      }
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: TaskTool.id, sessionID, callID: part.id },
        { args: taskArgs },
      )

      const taskAgent = yield* agents.get(task.agent)
      if (!taskAgent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
        throw error
      }

      let error: Error | undefined
      const taskAbort = new AbortController()
      const result = yield* taskTool
        .execute(taskArgs, {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID,
          abort: taskAbort.signal,
          callID: part.callID,
          extra: { bypassAgentCheck: true, promptOps },
          messages: msgs,
          metadata: (val: { title?: string; metadata?: Record<string, any> }) =>
            Effect.gen(function* () {
              part = yield* sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies SessionV1.ToolPart)
            }),
          ask: (req: any) =>
            permission
              .ask({
                ...req,
                sessionID,
                ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
              })
              .pipe(Effect.orDie),
        })
        .pipe(
          Effect.catchCause((cause) => {
            const defect = Cause.squash(cause)
            error = defect instanceof Error ? defect : new Error(String(defect))
            return Effect.logError("subtask execution failed", {
              error,
              agent: task.agent,
              description: task.description,
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              taskAbort.abort()
              assistantMessage.finish = "tool-calls"
              assistantMessage.time.completed = Date.now()
              yield* sessions.updateMessage(assistantMessage)
              if (part.state.status === "running") {
                yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    error: "Cancelled",
                    time: { start: part.state.time.start, end: Date.now() },
                    metadata: part.state.metadata,
                    input: part.state.input,
                  },
                } satisfies SessionV1.ToolPart)
              }
            }),
          ),
        )

      const attachments = result?.attachments?.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID,
        messageID: assistantMessage.id,
      }))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
        result,
      )

      assistantMessage.finish = "tool-calls"
      assistantMessage.time.completed = Date.now()
      yield* sessions.updateMessage(assistantMessage)

      if (result && part.state.status === "running") {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "completed",
            input: part.state.input,
            title: result.title,
            metadata: result.metadata,
            output: result.output,
            attachments,
            time: { ...part.state.time, end: Date.now() },
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!result) {
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
            time: {
              start: part.state.status === "running" ? part.state.time.start : Date.now(),
              end: Date.now(),
            },
            metadata: part.state.status === "pending" ? undefined : part.state.metadata,
            input: part.state.input,
          },
        } satisfies SessionV1.ToolPart)
      }

      if (!task.command) return

      const summaryUserMsg: SessionV1.User = {
        id: MessageID.ascending(),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: lastUser.agent,
        model: lastUser.model,
      }
      yield* sessions.updateMessage(summaryUserMsg)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryUserMsg.id,
        sessionID,
        type: "text",
        text: "Summarize the task tool output above and continue with your task.",
        synthetic: true,
      } satisfies SessionV1.TextPart)
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
          const { msg, part, cwd } = yield* Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (session.revert) {
              yield* revert.cleanup(session)
            }
            const agent = yield* agents.get(input.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              throw error
            }
            const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
            const userMsg: SessionV1.User = {
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              time: { created: Date.now() },
              role: "user",
              agent: input.agent,
              model: { providerID: model.providerID, modelID: model.modelID },
            }
            yield* sessions.updateMessage(userMsg)
            const userPart: SessionV1.Part = {
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The following tool was executed by the user",
              synthetic: true,
            }
            yield* sessions.updatePart(userPart)

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              sessionID: input.sessionID,
              parentID: userMsg.id,
              mode: input.agent,
              agent: input.agent,
              cost: 0,
              path: { cwd: ctx.directory, root: ctx.worktree },
              time: { created: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.modelID,
              providerID: model.providerID,
            }
            yield* sessions.updateMessage(msg)
            const started = Date.now()
            const part: SessionV1.ToolPart = {
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: ulid(),
              state: {
                status: "running",
                time: { start: started },
                input: { command: input.command },
              },
            }
            yield* sessions.updatePart(part)
            return { msg, part, cwd: ctx.directory }
          }).pipe(Effect.ensuring(markReady))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, cwd)
          let output = ""
          let aborted = false

          const finish = Effect.uninterruptible(
            Effect.gen(function* () {
              if (aborted) {
                output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
              }
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running") {
                part.state = {
                  status: "completed",
                  time: { ...part.state.time, end: completed },
                  input: part.state.input,
                  title: "",
                  metadata: { output },
                  output,
                }
                yield* sessions.updatePart(part)
              }
            }),
          )

          const exit = yield* restore(
            Effect.gen(function* () {
              const shellEnv = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: input.sessionID, callID: part.callID },
                { env: {} },
              )
              const cmd = ChildProcess.make(sh, args, {
                cwd,
                extendEnv: true,
                env: { ...shellEnv.env, TERM: "dumb" },
                stdin: "ignore",
                forceKillAfter: "3 seconds",
              })
              const handle = yield* spawner.spawn(cmd)
              yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  output += chunk
                  if (part.state.status === "running") {
                    part.state.metadata = { output }
                    yield* sessions.updatePart(part)
                  }
                }),
              )
              yield* handle.exitCode
            }).pipe(Effect.scoped, Effect.orDie),
          ).pipe(Effect.exit)

          if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause)) {
            aborted = true
          }
          yield* finish

          if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
            return yield* Effect.failCause(exit.cause)
          }

          return { info: msg, parts: [part] }
        }),
      )
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      return yield* provider.defaultModel().pipe(Effect.orDie)
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (
        current.agent !== info.agent ||
        current.model?.providerID !== info.model.providerID ||
        current.model?.id !== info.model.modelID ||
        (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<SessionV1.Part>[]> = Effect.fn(
        "SessionPrompt.resolveUserPart",
      )(function* (part) {
        if (part.type === "file") {
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
            const pieces: Draft<SessionV1.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]
            const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              const content = exit.value
              if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
              const items = Array.isArray(content.contents) ? content.contents : [content.contents]
              for (const c of items) {
                if (!c || typeof c !== "object") continue
                if ("text" in c && typeof c.text === "string" && c.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: c.text,
                  })
                } else if ("blob" in c && typeof c.blob === "string" && c.blob) {
                  const mime = "mimeType" in c && typeof c.mimeType === "string" ? c.mimeType : part.mime
                  const filename = "uri" in c && typeof c.uri === "string" ? c.uri : part.filename
                  const size = mcpResourceBase64Size(c.blob)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) is not a supported attachment type]`,
                    })
                    continue
                  }
                  if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary MCP resource omitted: ${filename ?? uri} (${mime}, ${formatMcpResourceBytes(size)}) exceeds ${formatMcpResourceBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                    })
                    continue
                  }
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename ?? uri} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: `data:${mime};base64,${c.blob}`,
                  })
                }
              }
            } else {
              const error = Cause.squash(exit.cause)
              yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }
            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  { ...part, messageID: info.id, sessionID: input.sessionID },
                ]
              }
              break
            case "file:": {
              yield* Effect.logInfo("file", { mime: part.mime })
              const filepath = fileURLToPath(part.url)
              const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

              const { read } = yield* registry.named()
              const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                const controller = new AbortController()
                return read
                  .execute(args, {
                    sessionID: input.sessionID,
                    abort: controller.signal,
                    agent: input.agent!,
                    messageID: info.id,
                    extra: { bypassCwdCheck: true, ...extra },
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  })
                  .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
              }

              if (mime === "text/plain") {
                let offset: number | undefined
                let limit: number | undefined
                const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  if (start === end) {
                    const symbols = yield* lsp.documentSymbol(filePathURI).pipe(Effect.catch(() => Effect.succeed([])))
                    for (const symbol of symbols) {
                      let r: LSP.Range | undefined
                      if ("range" in symbol) r = symbol.range
                      else if ("location" in symbol) r = symbol.location.range
                      if (r?.start?.line && r?.start?.line === start) {
                        start = r.start.line
                        end = r?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) limit = end - (offset - 1)
                }
                const args = { filePath: filepath, offset, limit }
                const pieces: Draft<SessionV1.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]
                const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                  Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                  Effect.exit,
                )
                if (Exit.isSuccess(exit)) {
                  const result = exit.value
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((a) => ({
                        ...a,
                        synthetic: true,
                        filename: a.filename ?? part.filename,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                  }
                } else {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read file", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                }
                return pieces
              }

              if (mime === "application/x-directory") {
                const args = { filePath: filepath }
                const exit = yield* execRead(args).pipe(Effect.exit)
                if (Exit.isFailure(exit)) {
                  const error = Cause.squash(exit.cause)
                  yield* Effect.logError("failed to read directory", { error, filepath })
                  const message = error instanceof Error ? error.message : String(error)
                  yield* events.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({ message }).toObject(),
                  })
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    },
                  ]
                }
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: exit.value.output,
                  },
                  { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                ]
              }

              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url:
                    `data:${mime};base64,` +
                    Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                  mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          const perm = Permission.evaluate("task", part.name, ag.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            { ...part, messageID: info.id, sessionID: input.sessionID },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
      })

      const resolvedParts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (input.noReply === true) return message
      const activeLoop = activeCycles.get(input.sessionID)
      if (activeLoop) {
        while (true) {
          const result = yield* state
            .tryRun(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
            .pipe(
              Effect.map((value) => ({ _tag: "done" as const, value })),
              Effect.catchTag("SessionBusyError", () => Effect.succeed({ _tag: "busy" as const })),
            )
          if (result._tag === "done") return result.value
          yield* Effect.sleep(Duration.millis(100))
        }
      }
      return yield* loop({ sessionID: input.sessionID })
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const runLoop: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.run")(
      function* (sessionID: SessionID) {
        return yield* Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          let structured: unknown
          let step = 0
          let reasoningStopRetries = 0
          const session = yield* sessions.get(sessionID).pipe(Effect.orDie)

          while (true) {
            yield* status.set(sessionID, { type: "busy" })
            yield* Effect.logInfo("loop", { "session.id": sessionID, step })

            let msgs = yield* MessageV2.filterCompactedEffect(sessionID).pipe(
              Effect.provideService(Database.Service, database),
            )

            const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

            if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

            const lastAssistantMsg = msgs.findLast(
              (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
            )
            // Some providers return "stop" even when the assistant message contains
            // tool calls. Keep the loop running so tool results can be sent back to
            // the model, but ignore cleanup-marked interrupted orphans.
            const hasToolCalls =
              lastAssistantMsg?.parts.some(
                (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
              ) ?? false

            if (
              lastAssistant?.finish &&
              !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
              !hasToolCalls &&
              lastAssistant.parentID === lastUser.id
            ) {
              const orphan = lastAssistantMsg?.parts.find(
                (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
              )
              if (orphan) {
                yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
                  "session.id": sessionID,
                  messageID: lastAssistant.id,
                  tool: orphan.tool,
                  callID: orphan.callID,
                })
              }
              yield* Effect.logInfo("exiting loop", { "session.id": sessionID })
              break
            }

            step++
            if (step === 1)
              yield* title({
                session,
                modelID: lastUser.model.modelID,
                providerID: lastUser.model.providerID,
                history: msgs,
              }).pipe(Effect.ignore, Effect.forkIn(scope))

            const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
            const task = tasks.pop()

            if (task?.type === "subtask") {
              yield* handleSubtask({ task, model, lastUser, sessionID, session, msgs })
              continue
            }

            if (task?.type === "compaction") {
              const result = yield* compaction.process({
                messages: msgs,
                parentID: lastUser.id,
                sessionID,
                auto: task.auto,
                overflow: task.overflow,
              })
              if (result === "stop") break
              continue
            }

            if (
              lastFinished &&
              lastFinished.summary !== true &&
              (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
            ) {
              yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
              continue
            }

            const agent = yield* agents.get(lastUser.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
              yield* events.publish(Session.Event.Error, { sessionID, error: error.toObject() })
              throw error
            }
            const maxSteps = agent.steps ?? Infinity
            const isLastStep = step >= maxSteps
            msgs = yield* SessionReminders.apply({ messages: msgs, agent, session }).pipe(
              Effect.provideService(RuntimeFlags.Service, flags),
              Effect.provideService(FSUtil.Service, fsys),
              Effect.provideService(Session.Service, sessions),
            )

            const msg: SessionV1.Assistant = {
              id: MessageID.ascending(),
              parentID: lastUser.id,
              role: "assistant",
              mode: agent.name,
              agent: agent.name,
              variant: lastUser.model.variant,
              path: { cwd: ctx.directory, root: ctx.worktree },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.id,
              providerID: model.providerID,
              time: { created: Date.now() },
              sessionID,
            }
            yield* sessions.updateMessage(msg)

            const finalizeInterruptedAssistant = Effect.gen(function* () {
              if (msg.time.completed) return
              msg.error ??= MessageV2.fromError(new DOMException("Aborted", "AbortError"), {
                providerID: msg.providerID,
                aborted: true,
              })
              msg.time.completed = Date.now()
              yield* sessions.updateMessage(msg)
            })

            const handle = yield* processor
              .create({
                assistantMessage: msg,
                sessionID,
                model,
              })
              .pipe(Effect.onInterrupt(() => finalizeInterruptedAssistant))

            const outcome: "break" | "continue" = yield* Effect.gen(function* () {
              const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
              const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false
              const promptOps = yield* ops()

              const tools = yield* SessionTools.resolve({
                agent,
                session,
                model,
                processor: handle,
                bypassAgentCheck,
                messages: msgs,
                promptOps,
              }).pipe(
                Effect.provideService(Plugin.Service, plugin),
                Effect.provideService(Permission.Service, permission),
                Effect.provideService(ToolRegistry.Service, registry),
                Effect.provideService(MCP.Service, mcp),
                Effect.provideService(Truncate.Service, truncate),
                Effect.provideService(RuntimeFlags.Service, flags),
              )

              if (lastUser.format?.type === "json_schema") {
                tools["StructuredOutput"] = createStructuredOutputTool({
                  schema: lastUser.format.schema,
                  onSuccess(output) {
                    structured = output
                  },
                })
              }

              if (step === 1)
                yield* summary
                  .summarize({ sessionID, messageID: lastUser.id })
                  .pipe(Effect.ignore, Effect.forkIn(scope))

              yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

              const [skills, env, instructions, mcpInstructions, modelMsgs] = yield* Effect.all([
                sys.skills(agent),
                sys.environment(model),
                instruction.system().pipe(Effect.orDie),
                sys.mcp(agent, session.permission),
                MessageV2.toModelMessagesEffect(msgs, model),
              ])
              const system = [
                ...env,
                ...instructions,
                ...(mcpInstructions ? [mcpInstructions] : []),
                ...(skills ? [skills] : []),
              ]
              const format = lastUser.format ?? { type: "text" as const }
              if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
              const enforceMarker =
                system.some((s) => s.includes(COMPLETION_MARKER)) ||
                msgs.some(
                  (m) =>
                    m.info.role === "user" &&
                    "system" in m.info &&
                    (m.info as SessionV1.User).system?.includes(COMPLETION_MARKER),
                )
              if (enforceMarker) system.push(COMPLETION_MARKER_INSTRUCTION)
              const result = yield* handle.process({
                user: lastUser,
                agent,
                permission: session.permission,
                sessionID,
                parentSessionID: session.parentID,
                system,
                messages: [
                  ...modelMsgs,
                  ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
                ],
                tools,
                model,
                toolChoice: format.type === "json_schema" ? "required" : undefined,
              })

              if (structured !== undefined) {
                handle.message.structured = structured
                handle.message.finish = handle.message.finish ?? "stop"
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }

              const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
              if (finished && !handle.message.error) {
                // Surface any content-filter finish (e.g. Anthropic stop_reason:
                // refusal) as an error. These turns may have produced no visible
                // output at all — previously the session went idle silently — or
                // partial text that was cut off by the provider's filter.
                if (handle.message.finish === "content-filter") {
                  handle.message.error = new SessionV1.ContentFilterError({
                    message: "The response was blocked by the provider's content filter",
                  }).toObject()
                  yield* sessions.updateMessage(handle.message)
                  yield* events.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                  return "break" as const
                }
                if (format.type === "json_schema") {
                  handle.message.error = new SessionV1.StructuredOutputError({
                    message: "Model did not produce structured output",
                    retries: 0,
                  }).toObject()
                  yield* sessions.updateMessage(handle.message)
                  return "break" as const
                }
              }

              if (handle.message.finish === "stop" && !handle.message.error) {
                const msgParts = yield* MessageV2.parts(handle.message.id).pipe(
                  Effect.provideService(Database.Service, database),
                )
                const hasReasoning = msgParts.some((p) => p.type === "reasoning")
                const hasText = msgParts.some((p) => p.type === "text")
                const hasPendingTool = msgParts.some((p) => p.type === "tool" && !isOrphanedInterruptedTool(p))
                if (hasReasoning && !hasText && !hasPendingTool) {
                  reasoningStopRetries++
                  if (reasoningStopRetries > 2) {
                    yield* Effect.logWarning("reasoning-stop retries exhausted, breaking loop", {
                      "session.id": sessionID,
                      messageID: handle.message.id,
                    })
                    return "break" as const
                  }
                  yield* Effect.logInfo(
                    "incomplete step (finish=stop, has reasoning but no text or tool calls), injecting retry prompt",
                    {
                      "session.id": sessionID,
                      messageID: handle.message.id,
                    },
                  )
                  const warnMsg: SessionV1.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    agent: lastUser.agent,
                    model: lastUser.model,
                    time: { created: Date.now() },
                  }
                  yield* sessions.updateMessage(warnMsg)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: warnMsg.id,
                    sessionID,
                    type: "text",
                    synthetic: true,
                    text: REASONING_STOP_WARNING,
                  })
                  return "continue" as const
                }
              }

              if (result === "stop") return "break" as const
              if (result === "compact") {
                yield* compaction.create({
                  sessionID,
                  agent: lastUser.agent,
                  model: lastUser.model,
                  auto: true,
                  overflow: !handle.message.finish,
                })
                return "continue" as const
              }

              if (handle.message.finish === "unknown" && !handle.message.error) {
                yield* Effect.logInfo("interrupted response (finish=unknown), injecting retry prompt", {
                  "session.id": sessionID,
                  messageID: handle.message.id,
                })
                const warnMsg: SessionV1.User = {
                  id: MessageID.ascending(),
                  sessionID,
                  role: "user",
                  agent: lastUser.agent,
                  model: lastUser.model,
                  time: { created: Date.now() },
                }
                yield* sessions.updateMessage(warnMsg)
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: warnMsg.id,
                  sessionID,
                  type: "text",
                  synthetic: true,
                  text: COMPLETION_INTERRUPTED_WARNING,
                })
                return "continue" as const
              }

              if (enforceMarker && finished && !handle.message.error) {
                const msgParts = yield* MessageV2.parts(handle.message.id).pipe(
                  Effect.provideService(Database.Service, database),
                )
                const textParts = msgParts.filter((p): p is SessionV1.TextPart => p.type === "text")
                const fullText = textParts.map((p) => p.text).join("")
                if (fullText.endsWith(COMPLETION_MARKER)) {
                  const lastText = textParts.at(-1)
                  if (lastText) {
                    yield* sessions.updatePart({
                      ...lastText,
                      text: lastText.text.slice(0, -COMPLETION_MARKER.length),
                    })
                  }
                } else {
                  yield* Effect.logInfo("missing completion marker, injecting retry prompt", {
                    "session.id": sessionID,
                    messageID: handle.message.id,
                  })
                  const warnMsg: SessionV1.User = {
                    id: MessageID.ascending(),
                    sessionID,
                    role: "user",
                    agent: lastUser.agent,
                    model: lastUser.model,
                    time: { created: Date.now() },
                  }
                  yield* sessions.updateMessage(warnMsg)
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    messageID: warnMsg.id,
                    sessionID,
                    type: "text",
                    synthetic: true,
                    text: COMPLETION_MARKER_MISSING_WARNING,
                  })
                  return "continue" as const
                }
              }

              return "continue" as const
            }).pipe(
              Effect.ensuring(instruction.clear(handle.message.id)),
              Effect.onInterrupt(() => finalizeInterruptedAssistant),
            )
            if (outcome === "break") break
            continue
          }

          yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
          return yield* lastAssistant(sessionID)
        })
      },
    )

    const loop: (input: LoopInput) => Effect.Effect<SessionV1.WithParts> = Effect.fn("SessionPrompt.loop")(function* (
      input: LoopInput,
    ) {
      return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
    })

    const loopRun: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error | Session.BusyError> =
      Effect.fn("SessionPrompt.loopRun")(function* (input: PromptInput) {
        const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        yield* revert.cleanup(session)
        // The prompt message is admitted only after the drain is acquired: a
        // busy session fails with SessionBusyError before any user message
        // exists, so a coalesced cycle round leaves no stray "[Cycle #N]"
        // prompt behind (and does not consume the round number either).
        return yield* state.tryRun(
          input.sessionID,
          lastAssistant(input.sessionID),
          Effect.gen(function* () {
            yield* createUserMessage(input).pipe(Effect.orDie)
            yield* sessions.touch(input.sessionID)
            return yield* runLoop(input.sessionID)
          }),
        )
      })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input, ready), ready)
    })

    const activeCycles = new Map<SessionID, Loop.LoopState>()
    // Process-lifetime identity for cross-process loop ownership: the owning
    // process renews a lease in the persisted loop state at every tick, and
    // other processes leave a freshly-leased loop alone.
    const loopOwnerId = ulid()

    const noReply = (sessionID: SessionID, messageID: MessageID | undefined, text: string) =>
      prompt({ sessionID, messageID, noReply: true, parts: [{ type: "text" as const, text }] })

    const publishCycleState = (sessionID: SessionID, state: Loop.LoopState | null) =>
      events.publish(LoopEvent.Updated, {
        sessionID,
        ...(state
          ? {
              state: {
mode: "cycle" as const,
                intervalStr: state.intervalStr,
                rounds: state.rounds,
                startedAt: state.startedAt,
                nextRunAt: state.nextRunAt,
                paused: state.paused,
                pending: state.pending,
                running: state.running,
                consecutiveFailures: state.consecutiveFailures,
                consecutiveDry: state.consecutiveDry,
                coalescedCount: state.coalescedCount,
                lastStatus: state.lastStatus,
              },
            }
          : {}),
      })

    const startLoopFiber = Effect.fn("SessionPrompt.startLoopFiber")(function* (input: {
      sessionID: SessionID
      intervalStr: string
      schedule: Loop.ScheduleInfo
      nextRunAt: number
      startRound: number
      startedAt: number
      paused: boolean
      consecutiveFailures: number
      consecutiveDry: number
      coalescedCount: number
      commandSeq: number
      lastStatus?: "success" | "fail"
    }) {
      const queue = yield* Queue.dropping<"scheduled" | "explicit">(1)
      const runtime: { state?: Loop.LoopState } = {}
      const word = "Cycle"
      const buildPrompt = (round: number) =>
        Loop.buildCyclePrompt(round)
      // Set when another process took over the persisted ownership lease; the
      // scheduler then shuts down quietly without clobbering the new owner's
      // state or broadcasting a stop it never received.
      let superseded = false
      // Last busy→idle transition for this session; drives the cycle mode's
      // idle-anchored schedule. Bootstrapped to the fiber start so a cycle
      // started on a long-idle session fires on time.
      const lastIdleAt = yield* Ref.make(input.startedAt)
      const persist = Effect.suspend(() => {
        const current = runtime.state
        if (!current) return Effect.void
        return Loop.persistLoopState(storage, input.sessionID, Loop.serializeLoopState(current))
      })
      const trigger = Effect.fnUntraced(function* (opts?: { queueWhenBusy?: boolean }) {
        const current = runtime.state
        if (!current) return
        // Ticks that arrive while paused must not queue work or inflate the
        // coalesced counter; the ticker simply advances to the next anchor.
        if (current.paused) return
        const st = yield* status.get(input.sessionID).pipe(Effect.catchCause(() => Effect.succeed({ type: "idle" as const })))
        // The current.running check closes the idle-blip window between the
        // worker picking up a round and runLoop marking the session busy,
        // where a tick could queue a round that fires seconds after the
        // previous one ends instead of one full idle interval later.
        if ((st.type === "busy" || current.running) && !opts?.queueWhenBusy) {
          current.coalescedCount++
          yield* persist
          yield* publishCycleState(input.sessionID, current).pipe(Effect.ignore)
          return
        }
        const accepted = yield* Queue.offer(queue, opts?.queueWhenBusy ? "explicit" : "scheduled")
        if (!accepted) {
          current.coalescedCount++
        } else {
          current.pending = true
        }
        yield* persist
        yield* publishCycleState(input.sessionID, current).pipe(Effect.ignore)
      })

      const ticker = Effect.gen(function* () {
        while (true) {
          const current = runtime.state
          if (!current) return yield* Effect.never
          const now = yield* Clock.currentTimeMillis
          yield* Effect.sleep(Duration.millis(Math.max(0, current.nextRunAt - now)))
          const wakeAt = yield* Clock.currentTimeMillis
          // Idle-anchored scheduling: fire only once the session has been
          // idle for the full interval, otherwise re-anchor to the target.
          const intervalMs = current.schedule.intervalMs
          const defer = Effect.fnUntraced(function* (target: number) {
            current.nextRunAt = target
            yield* persist
            if (!current.paused && !current.running) {
              yield* publishCycleState(input.sessionID, current).pipe(Effect.ignore)
            }
          })
          // The persisted state is the cross-process source of truth: another
          // process may have stopped the loop, issued pause/resume commands,
          // or taken over ownership entirely.
          const persisted = yield* Loop.readPersistedState(storage, input.sessionID)
          if (persisted.type === "missing") {
            yield* Effect.logInfo("loop stopped externally; scheduler exiting", { "session.id": input.sessionID })
            return
          }
          if (persisted.type === "found") {
            if (persisted.state.owner && persisted.state.owner.id !== loopOwnerId) {
              superseded = true
              yield* Effect.logInfo("loop owned by another process; scheduler exiting", {
                "session.id": input.sessionID,
              })
              return
            }
            // Commands issued in another process bump commandSeq; adopt their
            // mutations here so cross-process pause/resume takes effect.
            if (persisted.state.commandSeq > current.commandSeq) {
              current.commandSeq = persisted.state.commandSeq
              current.paused = persisted.state.paused
              current.consecutiveDry = persisted.state.consecutiveDry
              current.consecutiveFailures = persisted.state.consecutiveFailures
            }
          }
          // Renew the ownership lease so other processes leave this loop alone.
          current.owner = { id: loopOwnerId, at: wakeAt }
          if (current.paused) {
            yield* defer(wakeAt + intervalMs)
            continue
          }
          const st = yield* status
            .get(input.sessionID)
            .pipe(Effect.catchCause(() => Effect.succeed({ type: "idle" as const })))
          if (st.type === "busy" || current.running) {
            yield* defer(wakeAt + intervalMs)
            continue
          }
          const idleTarget = (yield* Ref.get(lastIdleAt)) + intervalMs
          if (idleTarget > wakeAt) {
            yield* defer(idleTarget)
            continue
          }
          yield* defer(wakeAt + intervalMs)
          yield* trigger().pipe(Effect.catchCause(() => Effect.void))
        }
      })

      const idleWatch =
        events.subscribe(SessionStatusEvent.Status).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.data.sessionID !== input.sessionID) return
                  if (event.data.status.type !== "idle") return
                  yield* Ref.set(lastIdleAt, yield* Clock.currentTimeMillis)
                }),
              ),
            )

      const worker = Effect.gen(function* () {
        while (true) {
          const tag = yield* Queue.take(queue)
          const current = runtime.state
          if (!current) return
          // Wait out busy sessions (and pauses for explicit triggers): /cycle
          // run and resume are queued behind busy work, and a scheduled tick
          // can race ahead of a user turn starting. A scheduled tick caught by
          // a pause is dropped instead of waited out, so pausing an automated
          // schedule actually holds until an explicit resume.
          while (true) {
            const st = yield* status.get(input.sessionID).pipe(Effect.catchCause(() => Effect.succeed({ type: "idle" as const })))
            if (!current.paused && st.type !== "busy") break
            if (current.paused && tag === "scheduled") break
            yield* Effect.sleep(Duration.millis(100))
          }
          if (current.paused && tag === "scheduled") {
            current.pending = false
            yield* persist
            yield* publishCycleState(input.sessionID, current).pipe(Effect.ignore)
            continue
          }
          while (Option.isSome(yield* Queue.poll(queue))) current.coalescedCount++
          // A deleted session can no longer host rounds; stop cleanly instead
          // of grinding through the consecutive-failure auto-stop threshold.
          const gone = yield* sessions.get(input.sessionID).pipe(Effect.option, Effect.map(Option.isNone))
          if (gone) {
            yield* Effect.logInfo("loop session deleted; stopping", { "session.id": input.sessionID })
            yield* Loop.clearPersistedState(storage, input.sessionID)
            yield* publishCycleState(input.sessionID, null).pipe(Effect.ignore)
            return
          }
          current.pending = false
          current.running = true
          yield* publishCycleState(input.sessionID, current).pipe(Effect.ignore)

          const round = current.rounds + 1
          const exit = yield* Effect.gen(function* () {
            const fullPrompt = buildPrompt(round)
            const before = yield* sessions.messages({ sessionID: input.sessionID, limit: 1 }).pipe(Effect.orDie)
            const boundaryId = before[0]?.info.id
            const result = yield* loopRun({
              sessionID: input.sessionID,
              model: yield* currentModel(input.sessionID),
              parts: [{ type: "text" as const, text: fullPrompt }],
            })
            // The boundary check alone misses mid-round aborts: onInterrupt
            // resolves with the current round's own aborted assistant message,
            // which is newer than the boundary.
            const aborted = result.info.role === "assistant" && result.info.error?.name === "MessageAbortedError"
            const interrupted = aborted || (boundaryId ? result.info.id <= boundaryId : false)
            return { fullPrompt, boundaryId, result, interrupted }
          }).pipe(
            Effect.map((data) =>
              data.interrupted
                ? ({ _tag: "interrupted" as const, fullPrompt: data.fullPrompt })
                : ({ _tag: "success" as const, ...data }),
            ),
            Effect.catchTag("SessionBusyError", () => Effect.succeed({ _tag: "coalesced" as const })),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.sync(() => ({ _tag: "fail" as const, cause })),
            ),
          )

          current.running = false
          // The round's busy→idle transition is known here deterministically;
          // recording it closes the event-delivery window in which the cycle
          // ticker could read a stale lastIdleAt and fire a round early. User
          // work still relies on the idleWatch subscription.
          yield* Ref.set(lastIdleAt, yield* Clock.currentTimeMillis)
          if (exit._tag === "coalesced") {
            current.coalescedCount++
            yield* persist
            yield* publishCycleState(input.sessionID, current).pipe(Effect.ignore)
            continue
          }
          current.rounds = round
          if (exit._tag === "success") {
            current.consecutiveFailures = 0
            current.lastStatus = "success"
            const roundMsgs = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
            const hasFileModification = roundMsgs.some(
              (msg) =>
                msg.info.role === "assistant" &&
                (!exit.boundaryId || msg.info.id > exit.boundaryId) &&
                msg.parts.some(
                  (part) =>
                    part.type === "tool" &&
                    part.tool !== undefined &&
                    FILE_MODIFY_TOOLS.has(part.tool) &&
                    part.state?.status === "completed",
                ),
            )
            if (hasFileModification) {
              current.consecutiveDry = 0
            } else {
              current.consecutiveDry++
            }
            yield* Loop.persistRoundResult(storage, input.sessionID, round, {
              timestamp: yield* Clock.currentTimeMillis,
              prompt: exit.fullPrompt,
              status: "success",
              response: exit.result.parts
                .filter((part): part is SessionV1.TextPart => part.type === "text")
                .map((part) => part.text)
                .join("\n")
                .slice(0, 5000),
            })
            if (current.consecutiveDry >= Loop.loopConfig.maxDryIterations) {
              const announce = !current.paused
              current.paused = true
              yield* persist
              yield* publishCycleState(input.sessionID, current).pipe(Effect.ignore)
              // A user pause that landed mid-round already told the user about
              // the pause; only announce auto-pauses.
              if (announce) {
                yield* noReply(
                  input.sessionID,
                  undefined,
                  `[${word} #${round}] Paused after ${Loop.loopConfig.maxDryIterations} consecutive iterations with no file modifications. Use /cycle resume to continue.`,
                )
              }
              continue
            }
          } else if (exit._tag === "interrupted") {
            // A user abort is a skipped round, not a failure: it must not
            // count toward consecutiveFailures or the auto-stop threshold.
            // Aborting an automated round means the user wants the automation
            // to hold, so pause instead of firing the next scheduled round.
            current.paused = true
            yield* noReply(
              input.sessionID,
              undefined,
              `[${word} #${round}] Iteration interrupted; cycle paused. Use /cycle resume to continue.`,
            )
            yield* Loop.persistRoundResult(storage, input.sessionID, round, {
              timestamp: yield* Clock.currentTimeMillis,
              prompt: exit.fullPrompt,
              status: "interrupted",
              response: "Iteration was interrupted",
            })
          } else {
            current.consecutiveFailures++
            current.lastStatus = "fail"
            const errorMsg = Cause.pretty(exit.cause).slice(0, 200)
            yield* Effect.logError("loop iteration failed", {
              "session.id": input.sessionID,
              round,
              cause: Cause.pretty(exit.cause),
            })
            yield* noReply(input.sessionID, undefined, `[${word} #${round}] Iteration failed: ${errorMsg}`)
            yield* Loop.persistRoundResult(storage, input.sessionID, round, {
              timestamp: yield* Clock.currentTimeMillis,
              prompt: buildPrompt(round),
              status: "fail",
              response: errorMsg,
            })
            if (current.consecutiveFailures >= Loop.loopConfig.maxConsecutiveFailures) {
              yield* Loop.clearPersistedState(storage, input.sessionID)
              yield* publishCycleState(input.sessionID, null).pipe(Effect.ignore)
              yield* noReply(
                input.sessionID,
                undefined,
                `[${word}] Auto-stopped after ${Loop.loopConfig.maxConsecutiveFailures} consecutive failures. Last error: ${errorMsg}`,
              )
              return
            }
          }

          yield* persist
          yield* publishCycleState(input.sessionID, current).pipe(Effect.ignore)
        }
      })

      const program = worker.pipe(
        Effect.raceFirst(ticker),
        Effect.raceFirst(idleWatch),
        Effect.asVoid,
        Effect.ensuring(
          Effect.gen(function* () {
            if (activeCycles.get(input.sessionID) === runtime.state) activeCycles.delete(input.sessionID)
            // A superseded scheduler must not clobber the new owner's
            // persisted state or broadcast a stop it never received.
            if (superseded) return
            yield* Loop.clearPersistedState(storage, input.sessionID).pipe(Effect.ignore)
            yield* publishCycleState(input.sessionID, null).pipe(Effect.ignore)
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("loop scheduler ended", { "session.id": input.sessionID, cause: Cause.pretty(cause) }),
        ),
      )
      const fiber = yield* program.pipe(Effect.forkIn(scope))
      const loopState: Loop.LoopState = {
        version: 1,
        intervalStr: input.intervalStr,
        schedule: input.schedule,
        rounds: input.startRound,
        fiber,
        trigger,
        startedAt: input.startedAt,
        nextRunAt: input.nextRunAt,
        paused: input.paused,
        pending: false,
        running: false,
        consecutiveFailures: input.consecutiveFailures,
        consecutiveDry: input.consecutiveDry,
        coalescedCount: input.coalescedCount,
        lastStatus: input.lastStatus,
        timezone: Loop.timezone(),
        owner: { id: loopOwnerId, at: input.startedAt },
        commandSeq: input.commandSeq,
      }
      runtime.state = loopState
      activeCycles.set(input.sessionID, loopState)
      yield* persist
      yield* publishCycleState(input.sessionID, loopState).pipe(Effect.ignore)
      return loopState
    })

    const activateLoop = Effect.fn("SessionPrompt.activateLoop")(function* (input: {
      sessionID: SessionID
      intervalStr: string
      schedule: Loop.ScheduleInfo
      nextRunAt: number
      startedAt: number
      announce?: boolean
      messageID?: MessageID
    }) {
      const existing = activeCycles.get(input.sessionID)
      if (existing) {
        // Overwrite policy: starting a new cycle always replaces the active one.
        yield* Fiber.interrupt(existing.fiber)
        yield* Loop.clearPersistedState(storage, input.sessionID)
      }

      const replaced = existing ? "; replaced previous cycle" : ""
      const text = `Cycle started: ${input.intervalStr}; first run ${new Date(input.nextRunAt).toTimeString().slice(0, 5)}; runs until stopped${replaced}`
      const message = input.announce ? yield* noReply(input.sessionID, input.messageID, text) : undefined
      const state = yield* startLoopFiber({
        sessionID: input.sessionID,
        intervalStr: input.intervalStr,
        schedule: input.schedule,
        nextRunAt: input.nextRunAt,
        startRound: 0,
        startedAt: input.startedAt,
        paused: false,
        consecutiveFailures: 0,
        consecutiveDry: 0,
        coalescedCount: 0,
        commandSeq: 0,
      })
      return { text, message }
    })

    const handleAutomationCommand = Effect.fn("SessionPrompt.automationCommand")(function* (
      input: CommandInput,
    ) {
      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const subcommand = args[0]
      const usageText = "Usage: /cycle [start] <interval>"
      const helpText = [
        usageText,
        "",
        "Subcommands:",
        "  start    Optional alias for starting a cycle",
        "  stop     Stop the active cycle for this session",
        "  pause    Temporarily pause the cycle (preserves round count)",
        "  resume   Resume a paused cycle",
        "  run      Force the next cycle iteration now instead of waiting",
        "  status   Show the current cycle status",
        "",
        "Start syntax:",
        "  /cycle [start] <interval>",
        "  Starting a new cycle replaces the active one.",
        "",
        `Minimum interval: ${Loop.loopConfig.minIntervalMs / 1000}s`,
        `Auto-stops after ${Loop.loopConfig.maxConsecutiveFailures} consecutive failures`,
        `Auto-pauses after ${Loop.loopConfig.maxDryIterations} consecutive rounds with no file modifications`,
        "",
        "Examples:",
        "  /cycle 5m",
        "  /cycle stop",
        "  /cycle pause",
        "  /cycle resume",
        "  /cycle status",
        "  /cycle run",
        "",
        "Intervals: ms, s, m, h (e.g. 30s, 5m, 1h, 2h30m)",
        "Cycles are idle-anchored: each iteration starts <interval> after the",
        "session became idle, not on a wall-clock schedule.",
        "",
        "Only one automation can be active per session.",
        "Cycle state and the latest 100 round results are saved in application data.",
      ].join("\n")
      const startsLoop =
        subcommand === "start" || subcommand === "at" || Loop.parseDuration(subcommand ?? "") !== undefined

      if (startsLoop) {
        if (subcommand === "at" || (subcommand === "start" && args[1] === "at")) {
          return yield* noReply(
            input.sessionID,
            input.messageID,
            `Cycles only support intervals; clock-time schedules are not supported.\n\n${usageText}`,
          )
        }
        const values = subcommand === "start" ? args.slice(1) : args
        const now = yield* Clock.currentTimeMillis
        let schedule: Loop.ScheduleInfo
        let intervalStr: string
        let nextRunAt: number

        const intervalStrRaw = values[0]
        const intervalMs = intervalStrRaw ? Loop.parseDuration(intervalStrRaw) : undefined
        if (!intervalMs) {
          return yield* noReply(
            input.sessionID,
            input.messageID,
            intervalStrRaw
              ? `Invalid interval: "${intervalStrRaw}". Supported units: ms, s, m, h (e.g. 5m, 30s, 1h)`
              : helpText,
          )
        }
        if (intervalMs < Loop.loopConfig.minIntervalMs) {
          return yield* noReply(
            input.sessionID,
            input.messageID,
            `Minimum interval is ${Loop.loopConfig.minIntervalMs / 1000}s. Use ${Loop.loopConfig.minIntervalMs / 1000}s or greater.`,
          )
        }
        schedule = { type: "cycle", intervalMs }
        intervalStr = `every ${intervalStrRaw}`
        nextRunAt = now + intervalMs

        for (let index = 1; index < values.length; index++) {
          const value = values[index]
          return yield* noReply(input.sessionID, input.messageID, `Unexpected argument: "${value}".\n\n${usageText}`)
        }

        const result = yield* activateLoop({
          sessionID: input.sessionID,
          intervalStr,
          schedule,
          nextRunAt,
          startedAt: now,
          announce: true,
          messageID: input.messageID,
        })
        return result.message ?? (yield* noReply(input.sessionID, input.messageID, result.text))
      }

      if (subcommand === "stop") {
        const existing = activeCycles.get(input.sessionID)
        if (!existing) {
          const persisted = yield* Loop.readPersistedState(storage, input.sessionID)
          if (persisted.type !== "found") {
            return yield* noReply(input.sessionID, input.messageID, `No active cycle for this session.`)
          }
          // The loop's scheduler lives in another opencode process; clearing
          // the persisted state tells it to shut down at its next tick.
          yield* Loop.clearPersistedState(storage, input.sessionID)
          yield* publishCycleState(input.sessionID, null).pipe(Effect.ignore)
          return yield* noReply(
            input.sessionID,
            input.messageID,
            `Cycle stopped (ran ${persisted.state.rounds} rounds in another process; it shuts down within one interval).`,
          )
        }
        const rounds = existing.rounds
        const failures = existing.consecutiveFailures
        const coalesced = existing.coalescedCount
        yield* Fiber.interrupt(existing.fiber)
        activeCycles.delete(input.sessionID)
        yield* Loop.clearPersistedState(storage, input.sessionID)
        yield* publishCycleState(input.sessionID, null).pipe(Effect.ignore)
        const parts = [`ran ${rounds} rounds`]
        if (failures > 0) parts.push(`${failures} consecutive failures`)
        if (coalesced > 0) parts.push(`${coalesced} ticks coalesced`)
        return yield* noReply(input.sessionID, input.messageID, `Cycle stopped (${parts.join(", ")}).`)
      }

      if (subcommand === "status") {
        const existing = activeCycles.get(input.sessionID)
        if (existing) {
          const stateInfo = existing.paused
            ? existing.consecutiveDry >= Loop.loopConfig.maxDryIterations
              ? ` (paused after ${existing.consecutiveDry} idle retries)`
              : " (paused)"
            : existing.running
              ? " (running)"
              : existing.pending
                ? " (queued)"
                : ""
          const parts = [`${existing.rounds} rounds completed`]
          if (existing.consecutiveFailures > 0) parts.push(`${existing.consecutiveFailures} consecutive failures`)
          if (existing.consecutiveDry > 0) parts.push(`${existing.consecutiveDry}/${Loop.loopConfig.maxDryIterations} consecutive idle iterations`)
          if (existing.coalescedCount > 0) parts.push(`${existing.coalescedCount} ticks coalesced`)
          return yield* noReply(
            input.sessionID,
            input.messageID,
            `Cycle active: ${existing.intervalStr}${stateInfo}, ${parts.join(", ")}`,
          )
        }
        const persisted = yield* Loop.readPersistedState(storage, input.sessionID)
        if (persisted.type === "found") {
          const parts = [`${persisted.state.rounds} rounds completed`]
          if (persisted.state.paused) parts.push("paused")
          return yield* noReply(
            input.sessionID,
            input.messageID,
            `Cycle active in another process: ${persisted.state.intervalStr}, ${parts.join(", ")}`,
          )
        }
        return yield* noReply(input.sessionID, input.messageID, `No active cycle for this session.`)
      }

      if (subcommand === "pause") {
        const existing = activeCycles.get(input.sessionID)
        if (!existing) {
          const persisted = yield* Loop.readPersistedState(storage, input.sessionID)
          if (persisted.type !== "found") {
            return yield* noReply(input.sessionID, input.messageID, `No active cycle for this session.`)
          }
          if (persisted.state.paused) {
            return yield* noReply(input.sessionID, input.messageID, `Cycle is already paused.`)
          }
          // The scheduler lives in another process and adopts this mutation
          // at its next tick (commandSeq guards against clobbering).
          yield* Loop.persistLoopState(storage, input.sessionID, {
            ...persisted.state,
            paused: true,
            commandSeq: persisted.state.commandSeq + 1,
          })
          return yield* noReply(
            input.sessionID,
            input.messageID,
            `Cycle paused after ${persisted.state.rounds} rounds (running in another process; takes effect within one interval). Use /cycle resume to continue.`,
          )
        }
        if (existing.paused) {
          return yield* noReply(input.sessionID, input.messageID, `Cycle is already paused.`)
        }
        existing.paused = true
        existing.commandSeq++
        yield* Loop.persistLoopState(storage, input.sessionID, Loop.serializeLoopState(existing))
        yield* publishCycleState(input.sessionID, existing).pipe(Effect.ignore)
        return yield* noReply(
          input.sessionID,
          input.messageID,
          `Cycle paused after ${existing.rounds} rounds. Use /cycle resume to continue.`,
        )
      }

      if (subcommand === "resume") {
        const existing = activeCycles.get(input.sessionID)
        if (!existing) {
          const persisted = yield* Loop.readPersistedState(storage, input.sessionID)
          if (persisted.type !== "found") {
            return yield* noReply(input.sessionID, input.messageID, `No active cycle for this session.`)
          }
          if (!persisted.state.paused) {
            return yield* noReply(input.sessionID, input.messageID, `Cycle is not paused.`)
          }
          // The scheduler lives in another process and adopts this mutation
          // at its next tick (commandSeq guards against clobbering).
          const now = yield* Clock.currentTimeMillis
          yield* Loop.persistLoopState(storage, input.sessionID, {
            ...persisted.state,
            paused: false,
            consecutiveDry: 0,
            consecutiveFailures: 0,
            nextRunAt: now + persisted.state.schedule.intervalMs,
            commandSeq: persisted.state.commandSeq + 1,
          })
          return yield* noReply(
            input.sessionID,
            input.messageID,
            `Cycle resumed (running in another process; resumes within one interval). ${persisted.state.rounds} rounds completed so far.`,
          )
        }
        if (!existing.paused) {
          return yield* noReply(input.sessionID, input.messageID, `Cycle is not paused.`)
        }
        existing.paused = false
        existing.consecutiveDry = 0
        existing.consecutiveFailures = 0
        existing.commandSeq++
        const now = yield* Clock.currentTimeMillis
        const nextRunAt = Loop.nextScheduledAt(existing.schedule, now)
        if (nextRunAt) existing.nextRunAt = nextRunAt
        yield* Loop.persistLoopState(storage, input.sessionID, Loop.serializeLoopState(existing))
        yield* publishCycleState(input.sessionID, existing).pipe(Effect.ignore)
        const st = yield* status.get(input.sessionID).pipe(Effect.catchCause(() => Effect.succeed({ type: "idle" as const })))
        yield* existing.trigger({ queueWhenBusy: true })
        return yield* noReply(
          input.sessionID,
          input.messageID,
          st.type === "busy"
            ? `Cycle resumed; a run will start after the current work finishes. ${existing.rounds} rounds completed so far.`
            : `Cycle resumed; a run is starting now. ${existing.rounds} rounds completed so far.`,
        )
      }

      if (subcommand === "run") {
        const existing = activeCycles.get(input.sessionID)
        if (!existing) {
          const persisted = yield* Loop.readPersistedState(storage, input.sessionID)
          if (persisted.type === "found") {
            return yield* noReply(
              input.sessionID,
              input.messageID,
              `Cycle is running in another process; explicit runs are only available in the owning process. Use /cycle resume or wait for the next tick.`,
            )
          }
          return yield* noReply(input.sessionID, input.messageID, `No active cycle for this session.`)
        }
        if (existing.paused) {
          return yield* noReply(
            input.sessionID,
            input.messageID,
            `Cycle is paused. Use /cycle resume first.`,
          )
        }
        const busy = (yield* status.get(input.sessionID).pipe(Effect.catchCause(() => Effect.succeed({ type: "idle" as const })))).type === "busy"
        yield* existing.trigger({ queueWhenBusy: true })
        if (busy) {
          return yield* noReply(
            input.sessionID,
            input.messageID,
            `Cycle is busy; this run will start after the current one finishes.`,
          )
        }
        return yield* noReply(input.sessionID, input.messageID, `Cycle triggered: next run starting now.`)
      }

      if (!subcommand || subcommand === "help") {
        return yield* noReply(input.sessionID, input.messageID, helpText)
      }

      return yield* noReply(input.sessionID, input.messageID, `Unknown subcommand: "${subcommand}".\n\n${helpText}`)
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      if (input.command === "cycle" || input.command === "loop") return yield* handleAutomationCommand(input)
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
      })
      yield* events.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    const recoverLoopSession: (sessionID: SessionID) => Effect.Effect<void> = Effect.fnUntraced(function* (
      sessionID: SessionID,
    ) {
      if (activeCycles.has(sessionID)) return
      const recovered = yield* Loop.readPersistedState(storage, sessionID)
      if (recovered.type !== "found") return
      const persisted = recovered.state
      const now = yield* Clock.currentTimeMillis
      // A fresh lease means another live process owns this loop. Stand by
      // until the lease would have gone stale, then re-check: if that process
      // died without cleanup we take over, otherwise we stay out of its way.
      const leaseMs = Loop.ownerLeaseMs(persisted.schedule.intervalMs)
      const owner = persisted.owner
      if (owner && owner.id !== loopOwnerId && now - owner.at < leaseMs) {
        yield* Effect.sleep(Duration.millis(owner.at + leaseMs - now + 1))
        return yield* recoverLoopSession(sessionID)
      }
      const nextRunAt = Loop.nextScheduledAt(persisted.schedule, now)
      if (!nextRunAt) {
        yield* Loop.clearPersistedState(storage, sessionID)
        return
      }
      // A deleted session can no longer host rounds; stop cleanly.
      const session = yield* sessions.get(sessionID).pipe(Effect.option)
      if (Option.isNone(session)) {
        yield* Loop.clearPersistedState(storage, sessionID)
        return
      }
      // Recovery runs outside any request scope, so the forked loop fiber
      // would otherwise carry no InstanceRef and every per-instance lookup
      // (Agent.defaultInfo, model resolution) would die at the first round.
      const ctx = yield* instanceStore.load({ directory: session.value.directory })
      yield* startLoopFiber({
        sessionID,
        intervalStr: persisted.intervalStr,
        schedule: persisted.schedule,
        nextRunAt,
        startRound: persisted.rounds,
        startedAt: persisted.startedAt,
        paused: persisted.paused,
        consecutiveFailures: persisted.consecutiveFailures,
        consecutiveDry: persisted.consecutiveDry,
        coalescedCount: persisted.coalescedCount,
        commandSeq: persisted.commandSeq,
        lastStatus: persisted.lastStatus,
      }).pipe(Effect.provideService(InstanceRef, ctx))
      yield* Effect.logInfo("loop auto-recovered", { "session.id": sessionID, rounds: persisted.rounds })
    })

    const recoverPersistedCycles = Effect.fn("SessionPrompt.recoverPersistedCycles")(function* () {
      const entries = yield* storage.list(["loop"]).pipe(Effect.orElseSucceed(() => []))
      for (const key of entries) {
        if (key.length !== 3 || key[2] !== "state") continue
        const sessionID = SessionID.make(key[1])
        // Fork per session: a foreign-owned loop's standby wait must not block
        // recovering the remaining sessions or finishing service init.
        yield* recoverLoopSession(sessionID).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logError("loop recovery failed", { "session.id": sessionID, cause: Cause.pretty(cause) }),
          ),
          Effect.forkIn(scope),
        )
      }
    })

    yield* recoverPersistedCycles().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("loop recovery failed", { cause: Cause.pretty(cause) }),
      ),
    )

    const loopState = Effect.fn("SessionPrompt.loopState")(function* () {
      const result: Record<string, LoopEvent.LoopState> = {}
      for (const [sessionID, state] of activeCycles) {
        result[sessionID] = {
          mode: "cycle" as const,
          intervalStr: state.intervalStr,
          rounds: state.rounds,
          startedAt: state.startedAt,
          nextRunAt: state.nextRunAt,
          paused: state.paused,
          pending: state.pending,
          running: state.running,
          consecutiveFailures: state.consecutiveFailures,
          consecutiveDry: state.consecutiveDry,
          coalescedCount: state.coalescedCount,
          lastStatus: state.lastStatus,
        }
      }
      return result
    })

    return Service.of({
      cancel,
      prompt,
      loopRun,
      loop,
      shell,
      command,
      resolvePromptParts,
      loopState,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({
  sessionID: SessionID,
}) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export { loopConfig } from "./loop"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    Agent.node,
    Provider.node,
    SessionProcessor.node,
    SessionCompaction.node,
    Plugin.node,
    Command.node,
    Config.node,
    Permission.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRunState.node,
    SessionRevert.node,
    SessionSummary.node,
    SystemPrompt.node,
    LLM.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Database.node,
    Storage.node,
    InstanceStore.node,
  ],
})

export * as SessionPrompt from "./prompt"
