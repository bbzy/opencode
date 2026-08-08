# PLAN: Cycle 模式可靠性与效率改进

## 背景

来自本机 5 个真实 `/cycle` 会话的执行分析（2026-08-07）：

- `ses_0242d0c57ffep18HpjhyD8NcNJ`（shiny-planet, deepseek_v4_flash_code）— 重复投递、resume 后 dry 不复位、cache 大面积失效
- `ses_02429c6c7ffenNhyZO0vbhQkt2`（nimble-panda, deepseek_v4_flash）— 双调度序列、子 agent 孤儿化、环境拆除后空转
- `ses_024289eecffe81F3WUBCxlBoIx`（silent-sailor, glm_5d2_fp8_1m_code）— 每轮 3 倍投递 + LIFO 乱序、重复 edit、58% dry、僵尸化
- `ses_023591ee3ffe4me6xPlh4QR5hc`（misty-river, kimi_k3_astra）— pause 8 秒后被绕过、jj 竞态自残、幻觉重复扫描
- `ses_023522dfdffe7qljoUT2sHsbZ0`（nimble-wolf, glm_5d2_fp8_1m_code）— 同一 grep 死循环 579 次烧 57% token、单 step 停滞 30 分钟

问题分类结论：引擎层 = 调度投递（重复/乱序）+ 状态机（pause 可绕过、dry 判定窄）+ 无护栏（无熔断/无超时/不压缩）；提示词层 = round prompt 零上下文（无历史、无 dry 状态、无完成出口、无验证与纪律要求）。

## 相关代码

- `packages/opencode/src/session/prompt.ts` — `startLoopFiber`（worker + ticker + idleWatch）、dry 判定与 auto-pause、trigger/coalesce、resume/stop
- `packages/opencode/src/session/loop.ts` — `loopConfig`、round prompt 生成 `buildCyclePrompt`、`persistLoopState`
- `packages/opencode/src/session/processor.ts` — 工具调用路径（熔断挂点候选）
- cycle-on-project skill — 内置 skill 定义（提示词纪律项）

## 执行项（按顺序挨个执行）

### Phase A — 引擎：调度正确性（P0）✅ 已完成（2026-08-08）

- [x] **A1. 修复 cycle prompt 重复投递与乱序**
  - 根因 1：`loopRun` 在获取 drain 前就创建 user 消息，被 `SessionBusyError` coalesce 的轮次留下流浪 `[Cycle #N]` prompt 且不消耗轮号 → 消息创建移入 `state.tryRun` 的 work effect 内
  - 根因 2：`activeCycles` 是进程本地 Map，多进程共享 storage 时各自恢复出独立调度器（重复序列、乱序补发、3 次 auto-stop 的来源）→ persisted state 增加 `owner` 租约 + `commandSeq`；ticker 每 tick 对账：丢失租约静默退出（不清状态）、被外部 clear 退出、commandSeq 更大则采纳跨进程命令；recovery 对新鲜外部租约待机、过期接管
  - 根因 3：轮次结束后的 idle-blip 窗口让 tick 入队导致 23 秒后背靠背触发 → `trigger` 增加 `current.running` 检查
  - 测试：loopRun 忙时 coalesce 不留流浪 prompt（`prompt.test.ts`）

- [x] **A2. 修复 pause 状态绕过 + resume 时 dry 计数处理**
  - 队列项打标 `scheduled`/`explicit`：被 pause 逮到的 scheduled tick 直接丢弃（不再等待后补发）；explicit（run/resume）保持等待
  - resume 复位计数：原有代码已复位 `consecutiveDry`/`consecutiveFailures`，观测到的"不复位"实为另一进程的调度器 —— 由 A1 的 owner 租约根治
  - 跨进程命令回退：本进程无活跃 cycle 但 persisted state 存在时，`stop` 清除状态（owner 下一 tick 退出）、`pause`/`resume` 变更状态并 bump `commandSeq`、`status` 显示"in another process"
  - 测试：auto-pause 后不再有点火（回归）、跨进程接管租约后静默退出、跨进程 resume 下一 tick 被采纳、跨进程 stop/pause/resume/status 回退

### Phase B — 提示词（P0，低成本高收益，紧跟 A 后做）✅ 已完成（2026-08-08）

- [x] **B1. round prompt 富化**
  - `loop.ts` `buildCyclePrompt(round, { consecutiveDry, previous })`：新增 ① 上轮摘要行（`Loop.latestRoundResult` 从 round-result 存储取上轮 response 尾部 300 字符，跨重启可用，无需新 state 字段）；② `Idle status: N/3` dry 状态与 auto-pause 阈值提醒；③ duplicate-delivery 指令（已完成该轮则简短确认、不要重做、不要自造轮号）；④ DONE 出口（无实质工作时报告 DONE + 理由，不要跑 status-check 凑数轮）
  - 测试：loop.test.ts 两个单测（有/无 context）；prompt.test.ts 集成测试（round 2 prompt 含上轮摘要 + Idle status 1/3）

- [x] **B2. cycle-on-project skill 增补纪律**（`packages/core/src/plugin/skill/cycle-on-project.md`）
  - Ironclad Rules 新增 3 条：会话无人值守禁止阻塞式提问（客观问题自决、主观问题选默认值并记录）；修复未验证不算完成（无验证路径先花一轮建验证环境）；VCS 与 edit 严格串行（jj 快照竞态纪律，历史搞乱先修历史）
  - Scheduler 小节新增：每轮小步快走（一轮一个可验证单元，超长轮是循环与幻觉温床）；backlog 持久化到 todo/文件而非散文记忆
  - Round Prompts 小节新增：解释 prompt 中的 Last completed iteration / Idle status / duplicate 提示如何解读；Termination 小节与 DONE 出口对齐（诚实 DONE 优于制造忙碌）
  - 测试：packages/core skill 注册测试通过

- [x] **B3. /cycle 启动回执话术修正**
  - "first run HH:MM" → "first run ~HH:MM, then each round starts <interval> after the session turns idle"，与 idle-anchor 实际行为对齐

### Phase C — 引擎：判定与熔断（P1）✅ 已完成（2026-08-08）

- [x] **C1. dry 判定扩展**
  - `Loop.roundMadeProgress`（loop.ts）：completed `edit`/`write`/`apply_patch` + completed bash 且命令匹配 VCS 变更 pattern（commit/split/squash/rebase/describe/bookmark move 等；`jj st`/`git status`/`jj log` 等只读刻意排除）→ `FILE_MODIFY_TOOLS` 移至 `Loop.FILE_MODIFY_TOOLS`
  - 微轮豁免未做：A 阶段已消除乱序微轮根因，B1 prompt 又给了 DONE 出口，无需再开豁口
  - 测试：loop.test.ts 8 组单测（工具类型 × VCS 命令 × boundary）

- [x] **C2. 重复工具调用熔断**
  - `processor.ts` 跨 step doom-loop 熔断：service 级 `doomLoopTracker`（session → 相同 tool+stableStringify(input) 连续次数），达 `processorConfig.doomLoopHardLimit`（默认 10）即 throw 硬停当轮（turn error → cycle 计 failure，5 连 failure auto-stop）
  - 关键发现：既有 per-step doom 检测（DOOM_LOOP_THRESHOLD=3）只看单条 assistant message 内的 parts，nimble-wolf 那种"每 provider turn 一次调用"的模式永远打不中；且默认 agent `doom_loop: "ask"` 在无人值守时要么 hang（question: allow 时）要么 DeniedError 终止 turn，都救不了跨 step 循环
  - 测试：processor-effect.test.ts 跨 step 熔断（每 turn 一次相同 grep，第 3 turn 触发 Circuit breaker）

- [x] **C3. 僵尸/环境故障即时停止**
  - 环境级错误立即停：`FATAL_ENVIRONMENT_PATTERN`（ProviderModelNotFound/ModelNotFound/realPath/ENOENT）命中即 clear state + 停止，不消耗失败预算；worker 成功路径（assistant message 带非 abort error → 现在计 failure）与 fail 路径都检测
  - 空响应即停：`consecutiveEmpty` 新持久化字段（decode 默认兼容）；round 无可见输出 parts（text/reasoning/tool）且 output tokens=0 → 计数，`loopConfig.maxEmptyRounds`（默认 2）即 auto-stop；resume/采纳命令时复位
  - 测试：prompt.test.ts 空响应 2 连即停（含 persisted state 清除与停止消息断言）

- [x] **C4. 单 step 停滞超时**
  - `processor.ts` stall watchdog：`processorConfig.stallTimeoutMs`（默认 10min，check 30s）无流事件且**无 tool 执行在途**（`ctx.toolcalls` 非空豁免，长 bash 不误伤）即 fail 当轮；错误为 NamedError.Unknown（不匹配 retryable pattern，不会被无限重试；也不含 AbortError 语义，cycle 计 failure 而非 user-abort）
  - 测试：processor-effect.test.ts 停滞触发（reasoning 后 Stream.never，200ms 阈值）+ tool 在途豁免（挂起 tool-call 不停滞）

### Phase D — 引擎：上下文与恢复（P2）

- [ ] **D1. 轮次边界上下文管理**
  - 现象：5 个会话 0 次成功 compaction，单步输入涨到 473K/510K；轮次边界全量冷读是 token 主因（cache.read=0 贡献 41M/43.9M）
  - 方向：轮末上下文超阈值（如 60%）时主动 compaction；排查缓存前缀被打翻的原因（不断变化的状态/时间戳注入位置），稳定前缀

- [ ] **D2. 流中断恢复去重**
  - 现象：流中断（finish reason: unknown）恢复后同轮重做，同一 edit 成功应用两次、同一总结报告两遍
  - 方向：恢复续跑前检查当轮已完成的工具调用，注入"已完成的操作清单"避免重复应用

### Phase E — 端到端验证

- [ ] **E1. 对照实验**：在测试仓库用 `/cycle 5m` 跑改进前后对照，对比 dry 率、重复投递次数、token 消耗、僵尸时长
- [ ] **E2. 更新 AGENTS.md** Cycle Automation 小节（如行为/配置项有变化），更新本 PLAN 勾选状态

## 决策记录

- 顺序理由：A1/A2 是所有会话共性的根因（与模型无关），先修；B1/B2 纯提示词改动成本最低、可直接减少空轮与无效产出；C/D 按价值/成本排序。
- 熔断阈值、停滞超时、dry 扩展规则在实施时定具体默认值，遵循 `loopConfig` 现有配置模式。
