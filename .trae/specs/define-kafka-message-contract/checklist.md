# Checklist

## 消息契约类型
- [x] `src/types.ts` 定义了 `Directive`，含 objective/background/context_refs/instructions/constraints/acceptance_criteria，三必填字段（objective/instructions/acceptance_criteria）标注
- [x] `src/types.ts` 定义了 `ExpectedOutput`，含 deliverables/result_file/result_schema/patch_required 四必填字段
- [x] `src/types.ts` 定义了 `TaskMessage`，含 schema_version、directive、expected_output、task_id、worker_id 等元信息
- [x] `src/types.ts` 定义了 `TaskResult`，字段与 `expected_output.result_schema` 对齐（status/summary/artifacts/patch/metrics/error/completed_at）
- [x] `src/types.ts` 定义了 `ControlMessage`（cmd/worker_id/issued_at）

## 任务指示（directive）落地
- [x] 投递到 `agent-tasks` 的每条消息都包含 `directive` 且三必填字段齐全
- [x] `produceTask.ts` 在 directive 缺必填字段时拒绝生产并非零退出
- [x] `consumeTasks.ts` 渲染的 `<task_id>.md` 包含"目标/背景/步骤/约束/验收标准/预期产物/结果写入路径与字段"各节
- [x] 渲染的 `.md` 末尾显式声明结果 JSON 写入 `expected_output.result_file`

## 预期返回（expected_output）落地
- [x] 每条任务消息都声明 `expected_output.deliverables`、`result_file`、`result_schema`、`patch_required`
- [x] `triggerTrae.ts` 使用 `expected_output.result_file` 作为 trae-cli `--output` 目标
- [x] `triggerTrae.ts` 使用 `timeout_sec`/`max_steps` 控制执行上限
- [x] worker 产出的结果 JSON 字段与 `expected_output.result_schema` 一致

## 结果消息对齐
- [x] `agent-results` 消息包含 schema_version/task_id/worker_id/status/summary/artifacts/patch/metrics/error/completed_at
- [x] `status` 取值限定为 success/failed/partial
- [x] `publishResults.ts` 发布前校验结果消息，不合格进死信
- [x] `consumeResults.ts` 按 task_id 落地到 `runtime/results/`

## 版本化与校验
- [x] 所有消息含 `schema_version`，当前为 `1.0`
- [x] 未知版本 / 结构不合法的消息进入 `runtime/state/_dlq/` 而非触发 trae-cli
- [x] 死信目录写入含字段名的错误日志

## 控制消息
- [x] `agent-control` topic 支持 stop/pause/resume 指令
- [x] `workerPoll.ts` 在下次轮询检测到 stop 时停止领取新任务，不中断在执行任务

## 编排者指令
- [x] `skills/orchestrator.md` 含附录 A 任务消息示例
- [x] `skills/orchestrator.md` 强调编排者只 produceTask、不自行执行子任务

## 端到端验证
- [x] `selftest.ts` 跑通 produce→consume→渲染→模拟执行→publish→consumeResults 闭环
- [x] selftest 断言 directive 三必填字段存在
- [x] selftest 断言 result 字段与 expected_output.result_schema 对齐
- [x] selftest 断言故意投递的非法消息进入死信目录
