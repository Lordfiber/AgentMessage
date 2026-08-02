# Tasks

- [x] Task 1: 定义消息契约 TypeScript 类型：在 `src/types.ts` 中定义 `TaskMessage`、`Directive`、`ExpectedOutput`、`TaskResult`、`ControlMessage` 接口，字段与 spec 附录 A/B/C 严格对齐，必填/可选标注清楚。
  - [x] SubTask 1.1: 定义 `Directive`（objective/background/context_refs/instructions/constraints/acceptance_criteria）
  - [x] SubTask 1.2: 定义 `ExpectedOutput`（deliverables/result_file/result_schema/patch_required）
  - [x] SubTask 1.3: 定义 `TaskMessage`（含 schema_version、directive、expected_output、元信息）
  - [x] SubTask 1.4: 定义 `TaskResult`（与 expected_output.result_schema 对齐）与 `ControlMessage`

- [x] Task 2: 实现契约校验器：在 `src/broker/validate.ts`（或合并入 kafkaHelper）中实现 `validateTaskMessage` / `validateTaskResult`，校验 schema_version=1.0、必填字段、枚举值；不合法时抛出含字段名的错误。
  - [x] SubTask 2.1: 任务消息必填字段校验（directive 三必填、expected_output 四必填、worker_id/task_id）
  - [x] SubTask 2.2: 结果消息枚举校验（status ∈ success/failed/partial）
  - [x] SubTask 2.3: 死信处理：校验失败的消息写入 `runtime/state/_dlq/<topic>-<ts>.json` 并记日志

- [x] Task 3: `produceTask.ts` 接入契约校验：读取任务 JSON → 校验通过后才生产到 `agent-tasks`，key=`worker_id`；校验失败非零退出。
  - [x] SubTask 3.1: 调用 validateTaskMessage，失败时打印缺哪个字段并 `process.exit(1)`
  - [x] SubTask 3.2: 生产成功后打印 `task_id`、`worker_id`、partition

- [x] Task 4: `consumeTasks.ts` 渲染任务文件：消费到合法任务消息后，用 `directive` + `expected_output` 渲染 `runtime/inbox/<task_id>.md`，并落 `<task_id>.json` 原始消息。
  - [x] SubTask 4.1: 未知/不合法消息进死信目录，不进 inbox
  - [x] SubTask 4.2: 渲染 Markdown 含"目标/背景/步骤/约束/验收标准/预期产物/结果写入路径与字段"各节
  - [x] SubTask 4.3: 文件末尾显式声明结果 JSON 写入 `expected_output.result_file` 的路径与字段
  - [x] SubTask 4.4: 按 task_id 写 `state/processed.jsonl` 去重

- [x] Task 5: `skills/worker_task_template.md` 与渲染逻辑对齐：模板占位符与 SubTask 4.2 各节一一对应，作为 `consumeTasks.ts` 渲染依据。
  - [x] SubTask 5.1: 模板覆盖 directive 全部字段与 expected_output
  - [x] SubTask 5.2: 模板明确要求 agent 按 `result_schema` 产出结果 JSON

- [x] Task 6: `publishResults.ts` / `consumeResults.ts` 对齐结果契约：发布前 `validateTaskResult` 校验；消费侧按 `task_id` 落 `runtime/results/`，不合法进死信。
  - [x] SubTask 6.1: publishResults 校验 outbox 中的 result.json，不合格移入 `_dlq`
  - [x] SubTask 6.2: consumeResults 落地并打印 `task_id`、`status`

- [x] Task 7: `triggerTrae.ts` 读取 `expected_output`：用 `expected_output.result_file` 作为 trae-cli `--output` 目标，用 `timeout_sec`/`max_steps` 作为超时与步数上限；执行后读取 result_file 并补全 `metrics`/`completed_at` 后移入 outbox。
  - [x] SubTask 7.1: spawn trae-cli 时传入 `--file <task_id>.md --output <result_file>`
  - [x] SubTask 7.2: 执行结束补全 `task_id`/`worker_id`/`completed_at`/`duration_sec`，缺失字段填默认值

- [x] Task 8: `skills/orchestrator.md` 指导编排者按契约生成任务消息：明确要求为每个子任务填充 `directive` 全字段与 `expected_output`，并给出 task JSON 示例。
  - [x] SubTask 8.1: 指令中嵌入附录 A 的任务消息示例
  - [x] SubTask 8.2: 强调"不要自己执行子任务，只 produceTask"

- [x] Task 9: `selftest.ts` 验证契约往返：构造一条符合附录 A 的任务消息 → produce → consume 渲染 .md → 模拟执行写符合附录 B 的 result → publish → consumeResults → 断言字段齐全且 status=success。
  - [x] SubTask 9.1: 断言 directive 三必填字段存在
  - [x] SubTask 9.2: 断言 result 字段与 expected_output.result_schema 对齐
  - [x] SubTask 9.3: 断言死信路径在故意投递非法消息时被触发

# Task Dependencies
- Task 2 依赖 Task 1（校验器依赖类型）
- Task 3/4/6 依赖 Task 2（produce/consume/publish 接入校验）
- Task 5 依赖 Task 4（模板与渲染对齐）
- Task 7 依赖 Task 1（读取 expected_output 类型）
- Task 9 依赖 Task 3/4/6/7（端到端往返）
- Task 8 可与 Task 5 并行
