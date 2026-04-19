# PLAN: 修复模型 stop 但 reasoning 中有 phantom tool call 不 retry 的问题

## 需求

当模型返回 `finish: "stop"` 但 reasoning 中包含了 tool call 语法（如 `<invoke name="xxx">`），系统应自动检测并重试，而不是直接退出 loop。

## 背景

- 真实案例：session `ses_09bb8d394ffeiITd6b3RaNhO6T`，DeepSeek V4 Pro 模型
- 模型在 reasoning 块中输出了 `<invoke name="clouddevice-...">` tool call 文本
- 但 API 返回的 `finish_reason` 是 `"stop"`（不是 `"tool-calls"`）
- 系统信任了 `stop`，直接退出 loop，tool 未被调用
- 现有 retry 机制只处理 `finish: "unknown"` 和缺失 completion marker，不处理 `"stop"`

## 相关代码

- `packages/opencode/src/session/prompt.ts:1354-1413` — finish_reason 处理和 retry 逻辑
- `packages/opencode/src/session/prompt.ts:100-105` — 已有 synthetic retry message 定义
- `packages/schema/src/v1/session.ts:118-128` — `ReasoningPart` 类型定义（有 `text` 字段）

## 决策记录

1. ✅ **检测方式** → **方案 B: 检测不完整 step**
   - 条件：`finish === "stop"` + assistant message 有 reasoning part + 没有 text part + 没有 tool part
   - 理由：不依赖字符串匹配，更通用，覆盖"模型思考了但没输出"的所有场景

2. ✅ **重试提示语** → **英文通用版**（与现有 `COMPLETION_INTERRUPTED_WARNING` 风格一致）
   - 内容：`"Auto-detection warning: the response was stopped while still in reasoning, without producing visible output or tool calls. The response may be incomplete. Please continue from where you left off."`
   - 附带 `Effect.logInfo` 结构化日志

## 实现方案

**修改文件**：`packages/opencode/src/session/prompt.ts`

**改动点**：
1. 新增常量 `REASONING_STOP_WARNING`（行 105 附近）
2. 在 `finished && !error` 块之后、`if (result === "stop")` 之前（约行 1376），插入检测逻辑：
   - 获取最后一条 assistant message 的 parts
   - 检查条件：`finish === "stop"` + 有 reasoning part + 没有 text part + 没有 tool part
   - 满足条件 → log + 注入 synthetic user message + `return "continue"`

**参考现有模式**：`COMPLETION_INTERRUPTED_WARNING` 的处理（行 1390-1413）