# 数据交互契约规范（Orchestrator · 数据入口视角）

> **我是 Orchestrator（主 Agent / TRAE-A）**，所有需求的唯一入口。
> 本规范固定我与各系统之间交流的**数据内容与格式**，让对端（知识库 / Hook 后端 / 团队与角色 Agent）无需猜测即可对接。
> 配套总览：`docs/architecture.html` · 角色定义：`docs/agents-system.md`。

---

## 1. 总览：我与谁交互

| # | 系统 | 方向 | 触发点 | 传输方式 | 格式定义 |
|---|------|------|--------|----------|----------|
| 1 | markitdown 输入清洗 | 我发起 | 收到原始需求时（仅我调用） | 本地脚本 `normalizeInput.ts` | §3 |
| 2 | Kafka 消息总线 | 我投递 / 我消费 | 团队路由投递 · 结果收口 | TS 脚本 producer/consumer | §4 |
| 3 | 知识库中间层（黑盒②） | 我发起 query / ingest | 拆解前查询 · 收口后沉淀 | HTTP `POST /knowledge/*` | §5 |
| 4 | Hook 黑盒后端（黑盒③） | 我上报（经中间件管道） | 阶段推进 / 事件发生 | HTTP `POST {AGENT_HOOK_URL}` | §6 |
| 5 | TRAE 引擎（trae-cli） | 角色 Agent 侧执行 | 任务执行（我拆解后的指令） | `trae-cli run --file <md>` | §7 |
| 6 | 团队 Agent / 角色 Agent | 我向下分发 / 向上收口 | 状态机每阶段 | 经 Kafka（2） | §4 |
| 7 | TRAE 插件（前端 · AgentPulse） | 我通知 | 消息已发出 / 状态已变更 / 门禁与回退 | 本地事件文件 `runtime/events/live.jsonl` + 可选 SSE | §11 |
| 8 | 任务工作区（信息入口） | 我建立 | 每次新开始一个任务（trace） | 本地文件夹 `runtime/workspaces/<trace_id>/` | §12 |

**职责边界**：我对每个系统只约定「字段 + 语义」，不关心对方内部实现（黑盒）。我产生的数据必须满足 §2 通用约定，否则对端无法正确路由。

---

## 2. 通用约定（所有交互必须遵守）

### 2.1 版本与标识

| 约定 | 值 | 说明 |
|------|-----|------|
| `schema_version` | `"1.0"` | 所有 Kafka 消息必带，版本不匹配直接拒绝（进死信） |
| `trace_id` | `tr-YYYYMMDD-NNNN` | **一条需求一条**，我生成，贯穿 PM→Dev→Review→QA→Deploy 全程 |
| `parent_task_id` | `p-YYYYMMDD-NNNN` | 我按阶段生成，一个阶段一个，聚合并行子任务 |
| `task_id` | `t-YYYYMMDD-NNNN` | 我按子任务生成，一个子任务一个，消息 key / 去重 / 对账 |
| `route_path` | `["root","team-cloud-door","dev"]` | 节点树路径，任意深度套娃路由与逐级收口（三层扩展，见 §9） |
| `target_agent_id` | `team-cloud-door` / `dev` | 消息发给哪个节点，节点只消费发给自己的（三层扩展，见 §9） |
| 时间戳 | ISO 8601 UTC，如 `2026-08-02T10:00:00Z` | 所有 `*_at` 字段 |
| `status` | `success \| failed \| partial` | 结果/完成状态枚举 |
| `cmd` | `stop \| pause \| resume` | 控制命令枚举（`*` 表示全体） |

### 2.2 ID 关系

```
trace_id (1) ──→ N × parent_task_id（每阶段 1 个）──→ N × task_id（阶段内并行子任务）
```

`trace_id` / `parent_task_id` 写进所有 Kafka 消息头与产出文件头；`task_id` 是 worker 去重、结果对账、hook 去重的依据。

### 2.3 关键配置（`config/settings.env`）

| 配置 | 用途 | 默认 |
|------|------|------|
| `KAFKA_BOOTSTRAP` | Kafka 地址 `<IP>:9092` | `192.168.1.10:9092` |
| `WORKER_ID` | 本机 worker 标识（如 `worker-A`） | — |
| `WORKER_ROLE` | 本机承担的角色（`pm/dev/review/qa/deploy`） | — |
| `AGENT_HOOK_URL` | Hook 黑盒后端地址；**留空 = no-op** | — |
| `POLL_MIN` | 计划任务轮询间隔（分钟） | `2` |
| `TRAE_ENGINE` / `TRAE_CLI_PATH` | trae 执行引擎与 CLI 路径 | `cli` / `trae-cli` |
| `RUNTIME_DIR` | 本地运行时目录 | `./runtime` |

---

## 3. 与 markitdown 输入清洗的交互（§1 表行 1）

**触发**：我（仅我）收到原始需求时，先清洗再喂 LLM。

```bash
npx tsx src/orchestrator/normalizeInput.ts <原始文件>          # doc/docx/pdf/txt/...
npx tsx src/orchestrator/normalizeInput.ts --text "<消息>" --ext docx
```

**输出**（脚本返回 JSON，同时落盘）：

```jsonc
{
  "ok": true,                     // false = markitdown 失败，已原样回退
  "outputMd": "d:/.../runtime/input-clean/nio.pdf.md",  // 清洗后 Markdown 绝对路径
  "converted": true,              // 是否真的走了 markitdown 转换
  "error": ""                     // 失败原因（converted=false 时）
}
```

**约定**：
- 产出目录固定 `runtime/input-clean/<原始文件名>.md`，`.md` 内容作为后续所有任务 directive 的 `objective/background` 素材。
- markitdown 不可用 → 原样拷贝为 `.md` 继续，**不中断流程**；`error` 字段照实上报。
- 此步骤不消耗系统 token（格式转换），hook 上报事件 `normalized`（带 `converted`）。

---

## 4. 与 Kafka 的交互（§1 表行 2）

主题：`agent-tasks`（key=worker_id / team_id，3 分区，保序）· `agent-results` · `agent-control`。
消费者统一 `fromBeginning: true` + 本地去重，防止离线漏消息。

### 4.1 agent-tasks —— 我投递（任务消息 TaskMessage）

```jsonc
{
  "schema_version": "1.0",
  "task_id": "t-20260802-0001",           // 必填 · 子任务唯一 ID
  "parent_task_id": "p-20260802-0001",    // 可选 · 阶段父 ID
  "trace_id": "tr-20260802-0001",         // 可选（必带）· 链路唯一 ID
  "worker_id": "worker-B",                // 必填 · 目标 worker（key）
  "worker_role": "pm",                    // 可选 · 目标角色
  "type": "dev",                          // 必填 · 枚举 pm|dev|review|qa|deploy
  "priority": 1,                          // 可选
  "created_at": "2026-08-02T10:00:00Z",   // 必填 · ISO 8601
  "timeout_sec": 1800,                    // 可选 · 超时容错依据
  "max_steps": 50,                        // 可选 · trae-cli 步数上限
  "directive": {                          // 必填 · 给对应 TRAE 的任务指示
    "objective": "为用户模块增加结构化日志",
    "background": "父任务要求提升可观测性；worker-C 负责单测",
    "context_refs": ["d:/workspace/foo/src/user.ts"],
    "instructions": ["在 login/logout 出口加 INFO 级结构化日志", "日志字段：trace_id、user_id、event、ts"],
    "constraints": { "language": "typescript", "forbidden": ["改 package.json 依赖版本"] },
    "acceptance_criteria": ["login/logout 均输出结构化日志", "npm run build 通过"]
  },
  "workspace": "d:/workspace/foo",        // 可选
  "expected_output": {                    // 必填 · 预期返回声明
    "deliverables": ["src/user.ts (修改)", "src/logger.ts (新增)"],
    "result_file": "runtime/outbox/t-20260802-0001.result.json",
    "result_schema": {
      "status": "success|failed|partial",
      "summary": "string", "artifacts": ["string"], "patch": "string (git diff)",
      "metrics": { "duration_sec": "number", "token_usage": { "input": "number", "output": "number" } },
      "error": "string"
    },
    "patch_required": true
  }
}
```

**投递方式**：

```bash
# 我把任务封装为 task.json 后
npx tsx src/broker/produceTask.ts <task.json>
```

**校验（不通过 → 拒绝投递，进死信，不触发执行）**：`schema_version`、`task_id`、`worker_id`、`type`、`created_at`、`directive.objective/instructions/acceptance_criteria`（非空数组）、`expected_output.deliverables/result_file/result_schema/patch_required`。详见 `src/broker/validate.ts`。

### 4.2 agent-results —— 我消费（结果消息 TaskResult）

```jsonc
{
  "schema_version": "1.0",
  "task_id": "t-20260802-0001",           // 必填 · 对账依据
  "trace_id": "tr-20260802-0001",         // 可选（必带）
  "worker_id": "worker-B",                // 必填
  "status": "success",                    // 必填 · success|failed|partial
  "summary": "在 user.ts login/logout 增加结构化日志，新增 logger.ts。",
  "artifacts": ["src/user.ts", "src/logger.ts"],
  "patch": "diff --git a/src/user.ts ...",
  "metrics": { "duration_sec": 87, "token_usage": { "input": 1234, "output": 567 } },  // 必填 · 角色 agent 的 token 消耗
  "error": "",
  "completed_at": "2026-08-02T10:03:21Z"  // 必填
}
```

**我的收口动作**：`consumeResults` 落 `runtime/results/` → 对账该阶段所有 `task_id` → 全部 `success` 则推进状态机；有 `failed`/超时未回传则走 §8 容错。结果沿 `route_path` 反向逐级上收（团队 → 我）。

### 4.3 agent-control —— 我消费（控制消息 ControlMessage）

```jsonc
{
  "schema_version": "1.0",
  "cmd": "pause",                 // 必填 · stop|pause|resume
  "worker_id": "*",               // 必填 · 目标 worker，'*' = 全体
  "issued_at": "2026-08-02T10:05:00Z"
}
```

---

## 5. 与知识库的交互（黑盒② · 精炼经验）

我只认两类请求，内部实现（向量化/检索/存储）一概不关心。

### 5.1 查询（执行前 / 拆解时）

```http
POST /knowledge/query
```

```jsonc
{
  "task_id": "t-20260802-0001",
  "worker_id": "worker-A",
  "objective": "为用户模块增加结构化日志",
  "query": "结构化日志 trace_id 传递最佳实践",
  "context_refs": ["d:/workspace/foo/src/user.ts"]
}
// ← 200
{
  "knowledge": [
    "本项目 logger.ts 已提供 withTrace(ctx) 工具，复用即可",
    "历史经验：login 出口需记录 user_id 脱敏值"
  ],
  "sources": ["t-20260715-0042", "t-20260720-0011"]
}
```

### 5.2 写入（执行后 / 收口时）

```http
POST /knowledge/ingest
```

```jsonc
{
  "task_id": "t-20260802-0001",
  "worker_id": "worker-A",
  "summary": "login/logout 接入 withTrace，新增 logger.ts 集中导出",
  "artifacts": ["src/user.ts", "src/logger.ts"],
  "lessons": ["trace_id 需从请求头透传，勿在函数内新生成"],
  "tags": ["logging", "observability"]
}
// ← 200
{ "accepted": true, "id": "kb-9821" }
```

### 5.3 与 Hook 的职责区分（重要）

| 维度 | 知识库 ingest | Hook 上报 |
|------|--------------|-----------|
| 内容 | **精炼经验**（做了什么/踩了什么坑/可复用模式） | **执行详情**（审计/监控/BI 用） |
| 字段 | summary · lessons · tags | status · artifacts · metrics · error |
| 消费方 | 下次任务的上下文注入 | 后端看板 / 告警 / 对账 |
| token 消耗 | 系统侧无（黑盒内部自理） | 无（HTTP POST） |

---

## 6. 与 Hook 黑盒后端的交互（黑盒③ · 广义后端 · 执行详情）

**我上报的入口**：不直接调 HTTP，而是 `emitAgentEvent(ctx)` 经统一中间件管道（`AgentContext` → `HookPayload`），加新关注点只在 `src/agent/middlewares/index.ts` 注册一行。**所有层级 agent（我 / 团队 / 角色）同一套**。

### 6.1 上报载荷 HookPayload

```http
POST {AGENT_HOOK_URL}            // 例: http://192.168.1.10:8080/agent-hook/complete
```

```jsonc
{
  "event": "stage_progress",      // agent_complete（角色/团队）| stage_progress（我，阶段推进）
  "trace_id": "tr-20260803-0001", // 链路唯一 ID（按它聚合整条链路）
  "task_id": "t-20260803-0002",
  "parent_task_id": "p-20260803-0002",
  "agent_role": "orchestrator",   // orchestrator | team | pm | dev | review | qa | deploy
  "worker_id": "worker-A",
  "stage": "dev",                 // 任务所属阶段（我的 stage_progress 可省略）
  "status": "success",            // success | failed | partial
  "summary": "dev 阶段收口：2/2 子任务成功，已推进 review。",
  "artifacts": ["runtime/results/t-20260803-0002.json"],
  "metrics": { "duration_sec": 87, "token_usage": { "input": 1234, "output": 567 } },  // ← token 消耗量随 hook 推送
  "error": "",
  "completed_at": "2026-08-03T09:05:27Z"
}
// ← 200
{ "accepted": true, "id": "hk-7788" }
```

### 6.2 事件语义（我对后端承诺的可见性）

| event | 谁发 | 含义 |
|-------|------|------|
| `trace_created` | 我 | 需求输入，生成 trace_id |
| `normalized` | 我 | markitdown 清洗完成（带 `converted`） |
| `produced` | 我 / 团队 | 任务投递到 agent-tasks |
| `consumed` | 角色 worker | 拉取到任务 |
| `running` | 角色 worker | 执行中 |
| `agent_complete` | 角色 / 团队 | 完成（带 token_usage） |
| `stage_progress` | 我 / 团队 | 收到结果，阶段推进 |
| `gate_passed` / `gate_rejected` | 我 | 人工门禁放行 / 拒绝 |
| `stage_rolled_back` | 我 | review 不通过回退 dev |
| `retry_scheduled` / `escalated` | 我 | 容错动作：重试 / 升级人工 |
| `timeout` / `result_missing` | 我 | 超时 / 对账缺失 |
| `trace_closed` | 我 | 整条链路关闭 |

### 6.3 容错（我承诺）

- `AGENT_HOOK_URL` 未配置 → **no-op**，系统照常跑。
- POST 失败/超时（10s）→ payload 落 `runtime/hooks/_failed/<ts>-<task_id>.json`，**绝不抛错**，主链路不受影响，恢复后可补发。
- 我侧 `orchestratorCollect` 用 `runtime/state/hooked.jsonl` 去重，避免重复 POST。

---

## 7. 与 TRAE 引擎的交互（§1 表行 5）

我拆解任务后，角色 Agent 侧按我的 directive 执行：

```bash
trae-cli run --file <task_id>.md --output <result_file>
# 参数：timeout_sec / max_steps 控上限；退出码非 0 → status=failed
```

**我的产出物约定**（写进 directive / expected_output，作为对端执行的唯一依据）：
- `<task_id>.md` = 任务指示（directive + 知识库 query 结果注入）
- `<task_id>.result.json` = 结果（对齐 §4.2 result_schema）
- 产出文件头必带 `trace_id`

---

## 8. 错误与容错规范（我兜底）

| 环节 | 检测方式 | 我的处理 | 上报事件 |
|------|----------|----------|----------|
| markitdown 失败 | `ok=false` | 原样回退 .md，不中断 | `normalized`(converted=false) |
| 任务校验不通过 | `validateTaskMessage` 抛错 | 拒绝投递 → 死信 `runtime/state/_dlq/` | `validation_failed` |
| Kafka 不可达（投递时） | producer 超时/连接错误 | 暂停分发 + 告警，恢复后续传 | `produce_failed` |
| trae-cli 执行失败 | 退出码非 0 | 结果照常回传；Dev 阶段回退重做，其他升级人工 | `agent_complete(failed)` → `stage_progress` |
| worker 离线 / 超时未回传 | 按 `timeout_sec` 检测 | 重试 1 次；仍失败回退 Dev 或升级人工 | `timeout` → `retry_scheduled`/`escalated` |
| Review 不通过 | `status=failed` + 问题清单 | 回退 Dev 重做，重新 produceTask | `stage_rolled_back` + `retry_scheduled` |
| 重做超 3 轮 | 重做计数 ≥ 3 | 停止自动循环，升级人工 | `escalated` |
| 门禁未通过 | 人工评审拒绝 | 状态机暂停，等人工放行/退回 | `gate_rejected` |
| 收口对账缺失 | 对账 `task_id` 集合 | 按"超时未回传"处理 | `result_missing` |
| Hook 不可达 | POST 失败/超时 | 落 `runtime/hooks/_failed/`，不中断 | （本地待补发） |

**边界承诺**：重试最多 1 次、回退重做最多 3 轮，超出即升级人工，**不会无限自动循环**；Kafka/worker 故障期间链路暂停而非丢失；Hook 故障期间事件落本地待补发。

---

## 9. Token 消耗上报规范

只有"LLM 会话"消耗 token，其余（清洗 / Kafka I/O / 知识库 / hook / 校验 / 门禁）不消耗。所有消耗量随 hook 推送（`metrics.token_usage`），后端按 `trace_id` 聚合。

| 消耗点 | 谁 | token_usage 来源 | 随哪个 hook |
|--------|-----|------------------|-------------|
| 团队路由判断 | 我（L1） | 我会话末尾读取 | `stage_progress` |
| 需求拆解 / 文档化 | 团队 Agent（L2） | 团队会话末尾读取 | `stage_progress` |
| 角色职责执行 | 角色 Agent（L3） | trae-cli 输出 → result `metrics` | `agent_complete` |
| 阶段收口聚合 | 我 / 团队（L1/L2） | 各层收口会话末尾读取 | `stage_progress` |

---

## 10. 三层团队扩展字段（文档已定 · 代码待同步）

> 三层 Agent 体系（我 → 团队 → 角色）已固化在 `docs/architecture.html`，以下字段属于该设计的契约部分。**目前 `src/types.ts` / `src/broker/validate.ts` 尚未包含，落地时需同步。**

| 字段 | 值示例 | 语义 |
|------|--------|------|
| `target_agent_id` | `team-cloud-door` / `dev` | 消息发给哪个节点（root / team / role） |
| `route_path` | `["root","team-cloud-door","dev"]` | 节点树路径（任意深度套娃） |
| `type` 扩展 | 增加 `team`（L2 分派）、`root`（L1） | 与现有 `pm/dev/review/qa/deploy` 并列 |
| Kafka key | `team_id` 或 `worker_id` | L2 团队任务 key=team_id，L3 角色任务 key=worker_id |
| 配置 | `TEAM_ID`（团队机器） | 与 `WORKER_ID` 并列 |
| 文件 | `config/teams.yaml` · `teamPoll.js` · `team_template.md` | 团队节点树配置与轮询入口（文档已列，代码未建） |

**分派语义**：`mode=dispatch` 继续下传（团队拆解）；`mode=leaf` 终结点——`leaf_behavior=role` 角色执行、`leaf_behavior=doc` 直传型（外部部门，原样出需求文档，不经 L3）。

---

## 11. 与 TRAE 插件（前端 · AgentPulse）的交互（§1 表行 7）

> 前端 = 运行在 TRAE 内的**自定义插件**（兼容 VS Code 扩展 API，TreeView / Webview / StatusBar / Notification 均可用）。我要通知它：**消息已发出、状态已变更、门禁与回退**。插件详情见 `docs/trae-plugin-ui.md`。

### 11.1 通知通道（两档，P0 默认）

| 档位 | 通道 | 适用 | 说明 |
|------|------|------|------|
| **P0（默认）** | 本地事件文件 `runtime/events/live.jsonl`（追加写） | 插件与 Orchestrator 同机（TRAE-A） | 我侧脚本经 `emitAgentEvent` 管道把每个事件追加一行；插件 `fs.watch` 监听 + 从断点续读，**零额外服务** |
| **P1（可选增强）** | SSE / WebSocket 推送 | 跨机器查看（其他 TRAE / 浏览器看板） | 由黑盒后端或独立事件服务转发，插件配置 `agentPulse.remoteUrl` 后订阅 |

### 11.2 通知消息格式 · UIEvent

```jsonc
{
  "schema_version": "1.0",
  "event": "produced",              // 事件名，与 §6.2 事件语义完全一致（produced/stage_progress/gate_passed/...）
  "channel": "ui",                  // 标识来源：UI 事件通道
  "trace_id": "tr-20260803-0001",   // 链路唯一 ID（插件按它分组渲染链路树）
  "task_id": "t-20260803-0002",
  "parent_task_id": "p-20260803-0001",
  "agent_role": "orchestrator",     // orchestrator | team | pm | dev | review | qa | deploy
  "worker_id": "worker-A",
  "stage": "dev",                   // 所属阶段
  "status": "success",              // 变更后的状态 success|failed|partial|pending|running|gated|rolled_back
  "route_path": ["root", "team-cloud-door", "dev"],
  "target_agent_id": "dev",
  "summary": "dev 子任务 t-20260803-0003 完成，patch 已产出。",
  "metrics": { "duration_sec": 87, "token_usage": { "input": 1234, "output": 567 } },
  "ts": "2026-08-03T09:05:27Z"      // 事件发生时间（ISO 8601）
}
```

### 11.3 产生源（我侧零改动 agent 代码）

- 在 `src/agent/middlewares/index.ts` 注册中间件 **⑥ `uiMiddleware`**（一行），管道把所有 `AgentContext` 事件转成 UIEvent 追加写 `live.jsonl`。
- **所有层级（我 / 团队 / 角色）自动生效**，与 Hook 中间件并列，互不影响。
- 与 Hook 的职责区分：Hook 上报**执行详情**给黑盒后端（审计/BI）；UIEvent 上报**实时流转**给插件看板（人看）。同一份 ctx，两个输出，事件语义一致。

### 11.4 插件消费方约定

- **初始化**：重放 `runtime/events/live.jsonl` 重建链路树（快照 = 重放结果），之后只消费增量行。
- **去重**：以 `(event, task_id, ts)` 为幂等键；同一 `trace_id` 同类事件 30s 内只弹一次通知。
- **渲染依据**：`status` 字段驱动节点着色；`route_path` 驱动树层级；`ts` 驱动事件流排序。

---

## 12. 信息入口 · 任务工作区（我侧唯一入口）

> 我是所有需求的唯一入口。**每次新开始一个任务（trace），我在本地建一个任务工作区文件夹**，把该需求相关的所有信息收拢进来，统一读取处理——之后我对本任务的任何处理（拆解 / 投递 / 收口 / 总结）都只从工作区取数，不散落各目录。

### 12.1 工作区目录结构

```
runtime/workspaces/
└── tr-20260803-0001/                  # 一个 trace 一个工作区（与 trace_id 同名）
    ├── meta.json                      # 工作区元信息（见 12.3，我维护）
    ├── input/                         # ① 原始输入（用户给的原文：doc/docx/pdf/消息…）
    │   └── nio.pdf
    ├── clean/                         # ② 清洗后（normalizeInput 输出，§3）
    │   └── nio.pdf.md
    ├── knowledge/                     # ③ 知识库 query 结果（拆解前，§5，可多个）
    │   └── query-001.json
    ├── docs/                          # ④ 需求文档（我拆解产物）
    │   ├── PRD.md                     #    边界 / 验收标准
    │   ├── dag.json                   #    任务依赖 DAG
    │   └── task-cards/                #    每个子任务一张卡（= produceTask 的 directive 素材，§4.1）
    │       ├── t-20260803-0002.md
    │       └── …
    └── results/                       # ⑤ 子任务结果回传（agent-results 落地副本，§4.2）
        ├── t-20260803-0002.result.json
        └── …
```

### 12.2 新建流程（每个 trace 走一遍）

| 步骤 | 动作 | 产出（进工作区） | 上报事件 |
|------|------|------------------|----------|
| ① | 收到原始需求 → 生成 `trace_id` → 建文件夹 | `workspaces/<trace_id>/` | `trace_created` |
| ② | 原始文件 / 消息原文存入 | `input/` | `ingested` |
| ③ | markitdown 清洗（失败原样回退，§3） | `clean/*.md` | `normalized` |
| ④ | 知识库 query（拆解前，§5.1） | `knowledge/query-*.json` | `queried` |
| ⑤ | 拆解 → PRD / 任务卡 / DAG | `docs/**` | `split` |
| ⑥ | 逐卡 produceTask 投递（directive 从任务卡生成，§4.1） | 读 `docs/` → 写 Kafka | `produced` |
| ⑦ | 收口：结果落 `results/` → 聚合总结 → ingest 知识库（§5.2）→ 更新 meta.json | `results/*.json` | `stage_progress` / `summarized` |

### 12.3 meta.json 格式

```jsonc
{
  "trace_id": "tr-20260803-0001",
  "title": "云门禁 → 结构化日志",
  "team_id": "team-cloud-door",
  "status": "active",                     // active | paused | closed
  "stages": ["pm", "dev", "review", "qa", "deploy"],
  "current_stage": "dev",
  "created_at": "2026-08-03T09:00:00Z",
  "input_file": "input/nio.pdf",
  "clean_file": "clean/nio.pdf.md",
  "token_usage": { "total": 6200, "by_agent": { "pm": 890, "dev": 2901 } },
  "files": ["docs/PRD.md", "docs/task-cards/t-20260803-0002.md", "…"]
}
```

### 12.4 统一读取规则（我每次会话的起点）

1. **新任务**：先建工作区 → 读 `meta.json` + `clean/*.md` + `knowledge/*` → 拆解 → 写 `docs/` → 投递。
2. **续处理**：直接读 `meta.json`（`current_stage`）→ 该阶段所需 `docs/task-cards` + `results` 对账 → 继续。
3. **收口**：读 `results/` 全部 → 聚合总结 → ingest 知识库 → 更新 `meta.json`（status / stages / token_usage）。
4. **命名即寻址**：目录/文件全部以 `trace_id` / `task_id` 命名，全局可寻址、可追溯；工作区就是该 trace 的"事实来源（source of truth）"。

### 12.5 与各契约的映射（一处收口）

| 工作区目录 | 对应契约 | 产生方 |
|-----------|----------|--------|
| `input/` | §3 markitdown 输入 | 我 |
| `clean/` | §3 normalizeInput 输出 | 我 |
| `knowledge/` | §5 query 响应 | 我 |
| `docs/task-cards/*.md` | §4.1 directive 素材 | 我（L1）/ 团队（L2） |
| `results/*.json` | §4.2 agent-results | worker 回传，我收口落地 |
| `meta.json` | §2 ID 体系 / 状态机 / §9 token | 我维护 |

### 12.6 新建流程补充：匹配团队 → 手动指派

> 第 ⑤ 步"拆解"后增加两件事（与 §13 联动）：
> - **团队自动匹配**：我不手动指定团队，而是根据需求内容识别涉及哪些团队（一个需求可涉及多个团队），`route_path` 呈多分支。
> - **手动指派**：拆出团队任务后，由人工为每个团队任务勾选团队内员工，指派后才投递（key=员工 worker_id）。

---

## 13. 员工目录与手动指派（团队由需求匹配）

### 13.1 员工目录（`config/members.yaml`）

每个团队一个员工列表；员工编号即 `worker_id`（投递 key）。示例：

```yaml
teams:
  team-cloud-door:            # 云门禁团队
    name: 云门禁团队
    members:
      - { id: sz_jsxt116, roles: [pm, dev],     online: true }
      - { id: sz_jsxt117, roles: [dev, review], online: true }
  team-carcloud:              # 车行云团队
    name: 车行云团队
    members:
      - { id: sz_jsxt118, roles: [dev, qa], online: true }
      - { id: sz_jsxt119, roles: [dev],      online: true }
```

### 13.2 团队自动匹配（多团队）

- 我根据需求内容识别归属团队/部门，**不手动指派团队**；一个需求可同时涉及多个团队。
- `route_path` 呈多分支：`root → [team-cloud-door, team-carcloud] → dev`。
- 直传型部门（云访客等）仍是 `mode=leaf / leaf_behavior=doc`：只原样出需求文档，不进指派环节。

### 13.3 手动指派（团队任务 → 员工）

- 拆出团队任务后，**人工**为每个团队任务勾选员工：可单人、可多人并行（同一任务多个员工各持任务卡副本，按 `task_id` 去重）。
- 指派后投递：`key = 员工编号（worker_id）`；消息带 `team_id` + `assignees`。
- 指派结果写回工作区 `meta.json`（`assignees` 字段）并随 Hook 上报。

### 13.4 消息契约扩展（文档已定 · 代码待同步）

| 字段 | 含义 | 现状 |
|------|------|------|
| `team_ids` | 需求匹配到的团队集合（可多个） | 文档已定，代码未加 |
| `assignees` | 人工指派的目标员工编号列表 | 文档已定，代码未加 |
| `target_agent_id` | 团队 `team_id` / 员工 `worker_id` | 同 §10 待同步 |

---

## 附录 A · 我生成任务的 Checklist（对端零猜测）

1. `schema_version="1.0"`，必填字段齐全（§4.1）
2. `trace_id` / `parent_task_id` / `task_id` 三级 ID 完整（§2.1）
3. `directive`：objective + instructions + acceptance_criteria 非空（§4.1）
4. `expected_output`：deliverables + result_file + result_schema + patch_required（§4.1）
5. 关键路径写进 `route_path` + `target_agent_id`（三层，§10）
6. 拆解前知识库 query、收口后 ingest（§5）
7. 每步 `emitAgentEvent` 上报，token_usage 随 hook（§6 / §9）
8. 每步有容错动作，失败不静默（§8）
9. 每步事件写入 UI 事件流（`live.jsonl`），TRAE 插件实时可见（§11）
10. 新任务先建工作区 `workspaces/<trace_id>/`，所有信息统一从工作区读写（§12）
