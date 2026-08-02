# Worker 任务 Markdown 模板说明

本文档定义 worker 接收到的任务 Markdown 结构。`src/broker/consumeTasks.ts` 中的
`renderTaskMarkdown(task)` 据此模板渲染：将 `TaskMessage` 字段填入对应占位符，
**缺失的可选字段对应章节会被省略**，必填字段章节始终保留。

渲染产物会与原始 JSON 一并写入 `runtime/inbox/<task_id>.md` 与 `<task_id>.json`。

---

## 模板结构

```
# 任务 {{task_id}}

- worker: {{worker_id}}
- type: {{type}}
- 创建时间: {{created_at}}

## 目标
{{directive.objective}}

## 背景
{{directive.background}}

## 上下文
- {{directive.context_refs[]}}

## 执行步骤
1. {{directive.instructions[]}}

## 约束
- 语言: {{directive.constraints.language}}
- 风格: {{directive.constraints.style}}
- 禁止: {{directive.constraints.forbidden[]}}

## 验收标准
- {{directive.acceptance_criteria[]}}

## 工作目录
- workspace: {{workspace}}
- workdir: {{workdir}}

## 预期产物
- {{expected_output.deliverables[]}}

## 结果提交
完成后请将结果 JSON 写入：`{{expected_output.result_file}}`
结果字段须符合：
- status: "success" | "failed" | "partial"
- summary: string
- artifacts: string[]
- patch: string（{{expected_output.patch_required}} ? "必须提供 git diff" : "可为空"）
- metrics: { duration_sec: number, token_usage: { input: number, output: number } }
- error: string（失败时填写，成功留空）
```

---

## 占位符 → 字段对照表

| 占位符 | TaskMessage 字段 | 必填 | 渲染规则 / 章节省略条件 |
| --- | --- | --- | --- |
| `{{task_id}}` | `task_id` | 是 | 标题 `# 任务 {task_id}` |
| `{{worker_id}}` | `worker_id` | 是 | 元信息行 |
| `{{type}}` | `type` | 是 | 元信息行；枚举 `code\|research\|review\|test` |
| `{{created_at}}` | `created_at` | 是 | 元信息行；ISO8601 |
| `{{directive.objective}}` | `directive.objective` | 是 | 「目标」章节正文 |
| `{{directive.background}}` | `directive.background` | 否 | 缺失则省略整个「背景」章节 |
| `{{directive.context_refs[]}}` | `directive.context_refs` | 否 | 每个元素一行 `- {ref}`；缺失或空数组则省略「上下文」章节 |
| `{{directive.instructions[]}}` | `directive.instructions` | 是 | 有序列表 `1. ... 2. ...` |
| `{{directive.constraints.language}}` | `directive.constraints.language` | 否 | `directive.constraints` 不存在则省略整个「约束」章节；章节内每子字段缺失则省略对应行 |
| `{{directive.constraints.style}}` | `directive.constraints.style` | 否 | 同上 |
| `{{directive.constraints.forbidden[]}}` | `directive.constraints.forbidden` | 否 | 渲染为 `- 禁止: a, b, c`（逗号连接）；缺失或空则省略该行 |
| `{{directive.acceptance_criteria[]}}` | `directive.acceptance_criteria` | 是 | 每个元素一行 `- {criterion}` |
| `{{workspace}}` | `workspace` | 否 | `workspace` 与 `workdir` 均缺失则省略「工作目录」章节；章节内缺失项省略对应行 |
| `{{workdir}}` | `workdir` | 否 | 同上 |
| `{{expected_output.deliverables[]}}` | `expected_output.deliverables` | 是 | 每个元素一行 `- {deliverable}` |
| `{{expected_output.result_file}}` | `expected_output.result_file` | 是 | 「结果提交」章节内行内代码 |
| `{{expected_output.patch_required}}` | `expected_output.patch_required` | 是 | 控制 `patch` 字段说明文案：`true` → "必须提供 git diff"；`false` → "可为空" |
| `{{expected_output.result_schema}}` | `expected_output.result_schema` | 是 | 见下文「result_schema」固定文案 |

> 未列入上表的 `TaskMessage` 字段（`schema_version`、`parent_task_id`、
> `worker_role`、`priority`、`timeout_sec`、`max_steps`）不渲染进 Markdown，
> 但会完整保留在 `<task_id>.json` 中。

---

## directive 全字段覆盖

`directive` 是任务的核心指令对象，模板覆盖其全部字段：

- `objective`（必填，string）：一句话目标，渲染为「目标」章节。
- `background`（可选，string）：背景说明，渲染为「背景」章节，缺失则省略。
- `context_refs`（可选，string[]）：上下文引用（如文件路径 / 资源定位符），每项一行
  渲染为「上下文」无序列表，缺失或为空则省略章节。
- `instructions`（必填，string[]）：有序执行步骤，渲染为「执行步骤」编号列表。
- `constraints`（可选，对象）：约束集合，包含
  - `language`（可选，string）
  - `style`（可选，string）
  - `forbidden`（可选，string[]，渲染时逗号连接）
  
  整个 `constraints` 缺失则省略「约束」章节；章节内各子字段缺失则省略对应行。
- `acceptance_criteria`（必填，string[]）：可核验的验收标准，每项一行渲染为
  「验收标准」无序列表。

---

## expected_output 全字段覆盖

`expected_output` 描述产物与结果提交契约，模板覆盖其全部字段：

- `deliverables`（必填，string[]）：预期产物（建议具体到文件路径），渲染为
  「预期产物」无序列表。
- `result_file`（必填，string）：结果 JSON 的写入路径，渲染为「结果提交」章节的
  行内代码。
- `result_schema`（必填，对象）：结果字段结构，渲染为「结果提交」章节下的固定
  字段列表（见下）。worker 必须按此 schema 产出结果 JSON。
- `patch_required`（必填，boolean）：决定 `patch` 字段说明——
  `true` 时文案为「必须提供 git diff」，`false` 时为「可为空」。

### result_schema（结果字段契约）

「结果提交」章节固定渲染如下字段列表（worker 须严格遵循）：

- `status`: `"success" | "failed" | "partial"`
- `summary`: `string` —— 任务结果摘要
- `artifacts`: `string[]` —— 产物文件路径列表
- `patch`: `string` —— git diff；`patch_required=true` 时必须提供，否则可为空字符串
- `metrics`: `{ duration_sec: number, token_usage: { input: number, output: number } }`
- `error`: `string` —— 失败时填写错误说明，成功时留空字符串

---

## Worker Agent 结果提交要求

Worker agent 在执行完任务后，**必须**：

1. 按 `result_schema` 字段结构组装结果 JSON。
2. 将结果 JSON 写入 `expected_output.result_file` 指定的路径
   （通常为 `runtime/outbox/<task_id>.result.json`）。
3. `status` 必须取 `success` / `failed` / `partial` 三者之一，且与实际完成情况一致。
4. `artifacts` 列出本次产出的全部文件路径（与 `deliverables` 对应）。
5. 当 `expected_output.patch_required === true` 时，`patch` 必须为合法的
   `git diff`，不得为空。
6. `metrics` 须如实填写执行耗时与 token 用量；`token_usage.input/output` 为数字。
7. 失败或部分完成时，`error` 字段须填写可读的错误原因；成功时留空字符串。

结果 JSON 示例：

```json
{
  "status": "success",
  "summary": "已为 user 模块 login/logout 增加结构化日志",
  "artifacts": ["src/user.ts", "src/logger.ts"],
  "patch": "diff --git a/src/user.ts ...",
  "metrics": {
    "duration_sec": 42,
    "token_usage": { "input": 12000, "output": 3500 }
  },
  "error": ""
}
```
