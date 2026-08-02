# Kafka 任务消息契约 Spec

## Why
当前实现计划只定义了任务/结果消息的最小字段。要让编排者（TRAE-A）分发的子任务能被 worker（TRAE-B/C）"开箱即执行"，投递到 Kafka 的消息体必须包含**给对应 TRAE 的明确任务指示（directive）**与**预期返回（expected_output）**，使 worker agent 无需猜测即可执行并产出结构化、可聚合的结果。

## What Changes
- 定义 `agent-tasks` 消息的完整契约：`directive`（给目标 TRAE 的任务指示）+ `expected_output`（预期返回声明）+ 元信息 + 控制字段。
- 定义 `agent-results` 消息契约，其字段与任务消息的 `expected_output.result_schema` 严格对齐。
- 定义 `agent-control` 控制消息（stop 等）。
- 引入 `schema_version` 做版本化，并在 produce/consume 两侧做契约校验，不合法消息进入死信目录而不触发 trae-cli。
- worker 任务 `.md` 文件由 `consumeTasks.ts` 用 `directive` + `expected_output` 渲染生成，确保 agent 拿到的是完整、明确的指令。

## Impact
- Affected code: `src/types.ts`、`src/broker/produceTask.ts`、`src/broker/consumeTasks.ts`、`src/broker/publishResults.ts`、`src/broker/consumeResults.ts`、`src/broker/selftest.ts`、`skills/worker_task_template.md`、`skills/orchestrator.md`。
- Affected specs: 无（首个 spec）。
- 部署：无额外部署影响，仅消息体结构变化。

---

## ADDED Requirements

### Requirement: 任务消息包含完整任务指示（directive）
系统 SHALL 让编排者投递到 `agent-tasks` 的每条消息包含顶层 `directive` 对象，承载给目标 TRAE 的明确、可执行任务指示。

`directive` SHALL 包含以下字段：
- `objective`（string，必填）：一句话目标。
- `background`（string，可选）：父任务背景与上下游依赖说明。
- `context_refs`（string[]，可选）：相关文件路径、参考链接等上下文。
- `instructions`（string[]，必填）：具体执行步骤，按序排列。
- `constraints`（object，可选）：含 `language`、`style`、`forbidden` 等约束。
- `acceptance_criteria`（string[]，必填）：可核验的验收标准。

#### Scenario: 编排者分发子任务
- **WHEN** 编排者把父任务拆成子任务并调用 `produceTask.ts` 投递
- **THEN** 每条 `agent-tasks` 消息的 `directive` 同时包含 `objective`、`instructions`、`acceptance_criteria`
- **AND** `worker_id` 字段指明唯一的执行 TRAE

#### Scenario: 缺失必填指示字段
- **WHEN** 一条任务消息的 `directive` 缺少 `objective` 或 `instructions` 或 `acceptance_criteria`
- **THEN** `produceTask.ts` 拒绝生产并报错退出（非零退出码）
- **AND** 不向 Kafka 投递任何消息

### Requirement: 任务消息声明预期返回（expected_output）
系统 SHALL 让每条任务消息包含顶层 `expected_output` 对象，明确告诉 worker TRAE 应返回什么、写到哪里、是否必须出 patch。

`expected_output` SHALL 包含：
- `deliverables`（string[]，必填）：预期产物清单（文件路径或文档）。
- `result_file`（string，必填）：worker 必须把结果 JSON 写到的本地路径（通常 `runtime/outbox/<task_id>.result.json`）。
- `result_schema`（object，必填）：声明结果 JSON 的字段结构，与 `agent-results` 契约一致。
- `patch_required`（boolean，必填）：是否必须输出 git patch。

#### Scenario: worker 知道要返回什么
- **WHEN** worker 消费到一条任务消息
- **THEN** `expected_output.deliverables` 列出预期产物
- **AND** `expected_output.result_file` 指明结果 JSON 写入路径
- **AND** `expected_output.result_schema` 描述每个结果字段

### Requirement: 结果消息与预期返回对齐
系统 SHALL 让 worker 产出的 `agent-results` 消息字段与该任务 `expected_output.result_schema` 严格对齐。

`agent-results` 消息 SHALL 包含：
- `schema_version`（string）
- `task_id`（string，与任务消息一致）
- `worker_id`（string）
- `status`（enum：`success` | `failed` | `partial`）
- `summary`（string）：人可读的完成摘要。
- `artifacts`（string[]）：实际产物路径。
- `patch`（string）：git diff；`patch_required=false` 时可为空。
- `metrics`（object）：含 `duration_sec`、`token_usage.{input,output}`。
- `error`（string）：失败/部分失败时的错误说明，成功时为空。
- `completed_at`（ISO8601 string）

#### Scenario: 任务成功完成
- **WHEN** worker agent 按 `directive` 完成任务并把结果写入 `result_file`
- **THEN** `publishResults.ts` 将该结果生产到 `agent-results`
- **AND** 消息 `status=success`、`artifacts` 与 `expected_output.deliverables` 对应、`patch` 非空（当 `patch_required=true`）

#### Scenario: 任务失败
- **WHEN** worker 执行出错或超时
- **THEN** 结果消息 `status=failed`，`error` 填写原因，`summary` 描述失败点
- **AND** `artifacts`/`patch` 反映实际部分产物（可为空）

### Requirement: 消息版本化与契约校验
系统 SHALL 为所有消息包含 `schema_version` 字段（当前 `1.0`），并在 produce 与 consume 两侧做结构校验。

#### Scenario: 收到未知版本
- **WHEN** `consumeTasks.ts` / `consumeResults.ts` 收到 `schema_version` 不为 `1.0` 的消息
- **THEN** 该消息被写入 `runtime/state/_dlq/`（死信目录）并记日志
- **AND** 不触发 trae-cli、不进入 `inbox/`

#### Scenario: 消息结构不合法
- **WHEN** 消息 JSON 解析失败或缺必填字段
- **THEN** 进入死信目录，不影响其它正常消息处理

### Requirement: 控制消息（agent-control）
系统 SHALL 支持 `agent-control` topic，用于向 worker 下达控制指令。

控制消息 SHALL 包含：
- `cmd`（enum：`stop` | `pause` | `resume`）
- `worker_id`（string，`*` 表示全体）
- `issued_at`（ISO8601 string）

#### Scenario: 下发停止指令
- **WHEN** 编排者向 `agent-control` 投递 `{"cmd":"stop","worker_id":"worker-B"}`
- **THEN** worker-B 的 `workerPoll.ts` 在下次轮询时检测到该指令并停止领取新任务
- **AND** 已在执行的任务不受中断

### Requirement: worker 任务文件由 directive 渲染
系统 SHALL 让 `consumeTasks.ts` 把任务消息的 `directive` 与 `expected_output` 渲染成一份结构化 Markdown 任务文件（`runtime/inbox/<task_id>.md`），作为 `trae-cli run --file` 的输入。

#### Scenario: 渲染任务文件
- **WHEN** `consumeTasks.ts` 消费到一条合法任务消息
- **THEN** 生成的 `<task_id>.md` 包含"目标 / 背景 / 步骤 / 约束 / 验收标准 / 预期产物 / 结果写入路径与字段"各节
- **AND** 文件末尾显式声明"完成后将结果 JSON 写入 `<expected_output.result_file>`"

---

## 附录 A：任务消息（`agent-tasks` value）示例

```json
{
  "schema_version": "1.0",
  "task_id": "t-20260802-0001",
  "parent_task_id": "p-20260802-0001",
  "worker_id": "worker-B",
  "worker_role": "实现工程师",
  "type": "code",
  "priority": 1,
  "created_at": "2026-08-02T10:00:00Z",
  "timeout_sec": 1800,
  "max_steps": 50,

  "directive": {
    "objective": "为用户模块增加结构化日志",
    "background": "父任务要求提升可观测性；本子任务负责实现层，worker-C 负责单测。",
    "context_refs": ["d:/workspace/foo/src/user.ts"],
    "instructions": [
      "在 login/logout 出口加 INFO 级结构化日志",
      "日志字段：trace_id、user_id、event、ts",
      "不改动 public API 签名"
    ],
    "constraints": {
      "language": "typescript",
      "style": "遵循现有 eslint 配置",
      "forbidden": ["修改 package.json 依赖版本"]
    },
    "acceptance_criteria": [
      "login/logout 均输出结构化日志",
      "npm run lint 通过",
      "npm run build 通过"
    ]
  },

  "workspace": "d:/workspace/foo",
  "workdir": "runtime/workspace/t-20260802-0001/",

  "expected_output": {
    "deliverables": ["src/user.ts (修改)", "src/logger.ts (新增)"],
    "result_file": "runtime/outbox/t-20260802-0001.result.json",
    "result_schema": {
      "status": "success|failed|partial",
      "summary": "string",
      "artifacts": ["string"],
      "patch": "string (git diff)",
      "metrics": { "duration_sec": "number", "token_usage": { "input": "number", "output": "number" } },
      "error": "string (失败时)"
    },
    "patch_required": true
  }
}
```

## 附录 B：结果消息（`agent-results` value）示例

```json
{
  "schema_version": "1.0",
  "task_id": "t-20260802-0001",
  "worker_id": "worker-B",
  "status": "success",
  "summary": "在 user.ts login/logout 增加结构化日志，新增 logger.ts。",
  "artifacts": ["src/user.ts", "src/logger.ts"],
  "patch": "diff --git a/src/user.ts ...",
  "metrics": { "duration_sec": 87, "token_usage": { "input": 1234, "output": 567 } },
  "error": "",
  "completed_at": "2026-08-02T10:03:21Z"
}
```

## 附录 C：控制消息（`agent-control` value）示例

```json
{ "schema_version": "1.0", "cmd": "stop", "worker_id": "worker-B", "issued_at": "2026-08-02T11:00:00Z" }
```
