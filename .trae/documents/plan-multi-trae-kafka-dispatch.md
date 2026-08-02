# 多台 TRAE 任务分发系统（Kafka + 定时触发，TypeScript 实现）实现计划

## Context（背景与目标）

局域网内有 3 台 Windows 电脑，每台装了 TRAE（字节 AI 编程 IDE/Agent 生态），各有独立账号。需求是：其中一台 TRAE-A 作为**编排者**，把一个任务拆解成子任务，分发给另外两台 TRAE-B / TRAE-C **执行**，再把结果收回来。

核心约束（用户已确认）：
1. 通信层用 **Kafka**（消息丢进 Kafka）。
2. Worker 端用 **Windows 定时任务触发**执行。
3. **通信环节尽量少消耗 token**——轮询/连接 Kafka、等待、回传都不能占用 TRAE agent 的会话。
4. **所有脚本用 TypeScript 实现**（Node.js 运行时）。

核心难点与解法：
- TRAE agent 不会自己醒来 → 用 **Windows 计划任务**驱动外部 TS 脚本。
- agent 不能空转耗 token → 把所有 Kafka I/O 移到 **TS 脚本**里，agent 只在"有真实任务"时被 `trae-cli` 非交互启动一次，执行完即退。
- TRAE 之间无原生通信 → Kafka 做消息总线。

关键可行性依据（已调研）：
- TRAE CLI（`traecli`）/ 开源 `trae-agent` 支持**非交互式执行**：`trae-cli run --file <task.md>` 或 `python -m trae_agent.cli run --task "..." --output result.json`。来源：https://docs.trae.cn/cli/get-started-with-trae-cli 、https://github.com/bytedance/trae-agent 。
- Kafka 3.3+ KRaft 模式可在 Windows 原生运行，无需 ZooKeeper。来源：https://kafka.apache.org/39/getting-started/quickstart/ 。
- Kafka 客户端用 **KafkaJS**（纯 JS，无原生编译依赖，Windows 友好）。来源：https://kafka.js.org/ 。

预期产出：一个可在 3 台 Windows 机器上部署的 `AgentMessage` 项目（TypeScript），跑通"编排者拆任务 → Kafka 分发 → worker 定时拉取并执行 → 结果回传 → 编排者聚合"的完整闭环。

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  TRAE-A (编排者机器)                                         │
│  · 人工触发一次 TRAE agent(orchestrator.md):                 │
│    拆任务 → 调 tsx src/broker/produceTask.ts 生产到 Kafka    │
│  · 计划任务 → node dist/triggers/orchestratorCollect.js:     │
│    consumeResults.ts 把 results 落本地                       │
│  · 人工触发一次 agent 收口: 读 results/ 聚合                  │
└──────────────┬──────────────────────────────────────────────┘
               │ produce (agent-tasks, key=worker_id)
               ▼
   ┌────────────────────────────────────────────┐
   │  Kafka 服务器 (独立机器, 推荐 Linux KRaft;  │
   │  也可 Docker / WSL2 / Windows KRaft)        │
   │  topics:                                    │
   │   agent-tasks  (key=worker_id)              │
   │   agent-results                             │
   │   agent-control (stop 等)                   │
   └───┬──────────────────┬──────────────────────┘
   consume(tasks,B)        consume(tasks,C)
            │                    │
┌───────────┴──────────┐ ┌───────┴────────────┐
│ Worker-B 机器         │ │ Worker-C 机器       │
│ 计划任务每 N 分钟调   │ │ 计划任务每 N 分钟调 │
│  node dist/triggers/  │ │  node dist/triggers│
│  workerPoll.js:       │ │  /workerPoll.js:   │
│  ① consumeTasks.ts    │ │  ① consumeTasks   │
│      → inbox/(空则退) │ │      → inbox/(空退)│
│  ② triggerTrae.ts     │ │  ② triggerTrae    │
│      spawn trae-cli   │ │      spawn trae-  │
│      run --file task  │ │      cli run ...  │
│      (agent 执行,写   │ │      (agent 执行) │
│       outbox/result)  │ │      → outbox     │
│  ③ publishResults.ts  │ │  ③ publishResults │
│      outbox→Kafka     │ │      outbox→Kafka │
└───────────────────────┘ └────────────────────┘
```

**省 token 原则**：agent 单次会话只做"读 1 个任务文件 → 执行 → 写 1 个结果文件 → 退出"。Kafka 连接、轮询、回传全在 TS 脚本里，零 token。inbox 为空时 `workerPoll` 直接 `process.exit(0)`，连 `trae-cli` 都不启动。

---

## 关键设计决策

### 1. Worker 执行引擎：trae-cli 非交互模式（首选）
- 每台 worker 装 `traecli`（PowerShell: `irm https://trae.cn/trae-cli/install.ps1 | iex`）并配好账号/API key。
- 触发：TS 用 `child_process.spawn('trae-cli', ['run','--file',taskMd,'--output',resultJson])`，超时控制，退出码映射 `status`。
- **降级方案**：若现场 trae-cli 不可用或必须用 Trae IDE 桌面版，`triggerTrae.ts` 改用 `@nut-tree/nut-js` 往 IDE 的 chat 输入框塞 prompt（脆弱，仅兜底）。`triggerTrae.ts` 设计为可插拔，靠 `config/settings.env` 里 `TRAE_ENGINE=cli|ide-ui` 切换。
- 选 cli 的理由：唯一能完美满足"定时触发 + 非交互 + 省 token + 可重复调度"。

### 2. 消息层：Kafka 单节点（部署在服务器）+ KafkaJS
- Kafka 部署在**独立服务器**（局域网内一台，推荐 **Linux KRaft**，生产最稳；也可 Docker `apache/kafka` / WSL2 / Windows KRaft）。3 台 TRAE 机器均作为客户端连 `<服务器IP>:9092`，编排者机器不再兼任 broker。
- 服务器配 `advertised.listeners=PLAINTEXT://<服务器IP>:9092` 让局域网可连；放行 9092 端口。
- Topics（由 `src/broker/createTopics.ts` 创建，幂等）：
  - `agent-tasks`：3 分区，用 `worker_id` 做 key 保证同 worker 顺序消费。
  - `agent-results`：1 分区。
  - `agent-control`：控制信号（如 `{"cmd":"stop","worker":"worker-B"}`）。
- 客户端 **KafkaJS**（纯 JS，Windows 免原生编译）。

### 3. 运行方式
- 开发/手动：`npx tsx src/broker/produceTask.ts <task.json>`。
- 生产/计划任务：先 `npm run build`（tsc 输出到 `dist/`），计划任务调 `node dist/triggers/workerPoll.js`。
- 计划任务注册：`src/deploy/registerTasks.ts` 通过 `child_process` 调 `schtasks`/`Register-ScheduledTask` 完成注册（全 TS，无需手写 ps1）。

### 4. 消息格式
任务（`agent-tasks` value，JSON）：
```json
{
  "task_id": "t-20260802-0001",
  "worker_id": "worker-B",
  "type": "code|research|review",
  "prompt": "在 d:/workspace/foo 实现 X 功能，要求...",
  "workspace": "d:/workspace/foo",
  "must_patch": false,
  "created_at": "2026-08-02T10:00:00Z",
  "priority": 1
}
```
结果（`agent-results` value，JSON）：
```json
{
  "task_id": "t-20260802-0001",
  "worker_id": "worker-B",
  "status": "success|failed",
  "summary": "实现了 X，新增 a.ts 修改 b.ts",
  "artifacts": ["a.ts","b.ts"],
  "patch": "diff --git ...",
  "duration_sec": 87,
  "token_usage": {"input": 1234, "output": 567}
}
```

### 5. 本地工作目录（每台机器，路径见 `config/settings.env`）
```
runtime/
  inbox/       # consumeTasks 写入的待执行任务 (.json + .md)
  outbox/      # agent 执行完写的结果 (.result.json)
  results/     # (仅编排者) consumeResults 写入的聚合结果
  workspace/   # agent 实际干活的仓库根，按 task_id 子目录
  state/       # processed.jsonl 去重 + worker.lock 防重入
```

---

## 项目结构（待创建，全 TypeScript）

```
AgentMessage/
├── src/
│   ├── types.ts                # Task / TaskResult / Control 接口
│   ├── config/
│   │   └── settings.ts         # 读 settings.env + workers.yaml (dotenv + yaml)
│   ├── broker/                 # Kafka 桥接层 (TS, 不耗 token)
│   │   ├── kafkaHelper.ts      #   KafkaJS producer/consumer 封装 + 重试
│   │   ├── createTopics.ts     #   建 topic (幂等)
│   │   ├── produceTask.ts      #   编排者: 读 task JSON → 生产 agent-tasks
│   │   ├── consumeTasks.ts     #   worker: consumeTasks <worker_id> → inbox/
│   │   ├── publishResults.ts   #   worker: outbox/ → agent-results
│   │   ├── consumeResults.ts   #   编排者: agent-results → results/
│   │   └── selftest.ts         #   单机闭环自测
│   ├── triggers/               # 计划任务入口 (TS)
│   │   ├── triggerTrae.ts      #   可插拔 TRAE 触发器 (cli 首选, ide-ui 兜底)
│   │   ├── workerPoll.ts       #   worker 每 N 分钟: consume→trigger→publish
│   │   └── orchestratorCollect.ts  # 编排者: consumeResults
│   └── deploy/
│       └── registerTasks.ts    #   用 schtasks/Register-ScheduledTask 注册计划任务
├── skills/                     # TRAE agent 指令/模板 (markdown, 非 TS)
│   ├── orchestrator.md         #   编排者: 拆任务 + 调 produceTask.ts
│   ├── worker_task_template.md #   生成 worker 任务 .md 的模板
│   └── worker_system.md        #   worker agent 系统约束
├── config/
│   ├── settings.env.example    #   KAFKA_BOOTSTRAP/WORKER_ID/POLL_MIN/TRAE_ENGINE...
│   └── workers.yaml            #   worker 注册表: id/机器IP/分区
├── deploy/
│   ├── kafka-server-setup.md   #   Kafka 服务器部署 (Linux KRaft 为主, 附 Docker/WSL2/Windows)
│   └── install-trae-cli.md     #   trae-cli 安装与账号配置
├── runtime/                    # 本地工作目录 (.gitkeep)
│   ├── inbox/  outbox/  results/  workspace/  state/
├── package.json                #   kafkajs, yaml, dotenv, tsx, typescript, @types/node; 可选 @nut-tree/nut-js
├── tsconfig.json
├── .gitignore
└── README.md
```

> 说明：`skills/*.md` 与 `deploy/*.md` 是文档/agent 指令（非程序脚本），保持 markdown。所有**可执行脚本**均为 TypeScript。

---

## 实现步骤（分阶段）

### 阶段 0：项目骨架
- `package.json`：依赖 `kafkajs`、`yaml`、`dotenv`、`tsx`、`typescript`、`@types/node`、`@types/yaml`；可选 `@nut-tree/nut-js`（IDE-UI 兜底）。scripts: `build`→`tsc`、`selftest`→`tsx src/broker/selftest.ts`。
- `tsconfig.json`：`target ES2022`、`module commonjs`（计划任务用 node 直跑 `dist/*.js`）、`outDir dist`、`strict true`、`esModuleInterop true`。
- `.gitignore`：`node_modules/`、`dist/`、`runtime/*`（保留 `.gitkeep`）、`*.log`、`config/settings.env`。
- `config/settings.env.example`、`config/workers.yaml` 示例；`src/config/settings.ts` 集中加载。
- `src/types.ts`：`Task`、`TaskResult`、`ControlMsg` 接口。
- `README.md` 总览 + 快速开始。

### 阶段 1：Kafka 桥接层（src/broker/）
- `kafkaHelper.ts`：封装 KafkaJS `Producer`/`Consumer`，JSON 序列化，delivery 回调，按 `worker_id` 过滤（订阅 `agent-tasks` 全分区，客户端按消息 key/header 过滤），手动 commit + 落 `state/processed.jsonl` 防重复。
- `createTopics.ts`：用 KafkaJS admin 建 3 个 topic，幂等（已存在则跳过）。
- `produceTask.ts`：`tsx src/broker/produceTask.ts <task.json>` → 生产到 `agent-tasks`，key=`worker_id`。
- `consumeTasks.ts`：`tsx src/broker/consumeTasks.ts worker-B` → 拉分给自己的消息 → 写 `runtime/inbox/<task_id>.json` + 用 `worker_task_template.md` 渲染 `<task_id>.md`。已处理 task_id 记 `state/processed.jsonl` 防重。
- `publishResults.ts`：扫 `runtime/outbox/*.result.json` → 生产到 `agent-results` → 成功后移到 `outbox/_sent/`。
- `consumeResults.ts`：消费 `agent-results` → 写 `runtime/results/<task_id>.result.json`。
- `selftest.ts`：单机起 Kafka 后，produce 一个 echo 任务 → 跑 consumeTasks → 模拟执行写 outbox → publishResults → consumeResults，断言闭环。

### 阶段 2：TRAE 触发器（src/triggers/）
- `triggerTrae.ts`：
  - `TRAE_ENGINE=cli`：`spawn('trae-cli', ['run','--file',taskMd,'--output',resultJson, mustPatch?'--must-patch':null].filter(Boolean)`，超时控制，捕获 stdout/stderr，退出码 0→`success` 否→`failed`。
  - `TRAE_ENGINE=ide-ui`：用 `@nut-tree/nut-js` 启动/聚焦 Trae IDE，定位 chat 输入框，粘贴 prompt，回车，轮询输出直到完成（兜底，标注脆弱）。
  - 生成 `outbox/<task_id>.result.json`（含 status/summary/artifacts/duration/token_usage）。
- `workerPoll.ts`：顺序执行 `consumeTasks` → 若 `inbox/` 非空则逐个 `triggerTrae` → `publishResults`。用 `state/worker.lock`（`fs.openSync` 独占锁）防并发重入；inbox 空→`process.exit(0)`。
- `orchestratorCollect.ts`：调 `consumeResults`。

### 阶段 3：Skills / Agent 指令（skills/）
- `orchestrator.md`：编排者 agent 的 prompt——读用户需求→拆成 N 个子任务→为每个生成 task JSON→对每个调 `npx tsx src/broker/produceTask.ts <file>`→输出分发摘要。强调"不要自己执行子任务"。
- `worker_task_template.md`：渲染 worker 任务文件的模板（含任务 prompt、workspace 路径、产出要求、结果 JSON 写到 outbox 的明确指令）。
- `worker_system.md`：worker agent 系统约束——只做当前任务、产物写到 `runtime/workspace/<task_id>/`、把结果摘要写到 `outbox/<task_id>.result.json`、完成后立即结束。

### 阶段 4：部署（src/deploy/ + deploy/）
- `src/deploy/registerTasks.ts`：通过 `child_process.execSync` 调 `schtasks /Create` 或 PowerShell `Register-ScheduledTask`，参数化 worker_id、`node dist/...` 路径、间隔。注册 `AgentMessage-WorkerPoll`、`AgentMessage-OrchCollect` 两个任务。
- `deploy/kafka-server-setup.md`：以 **Linux KRaft** 为主（`kafka-storage.sh random-uuid` → `format` → `kafka-server-start.sh`，最稳）；附 Docker `docker run -p 9092:9092 apache/kafka`、WSL2、Windows KRaft 三种备选。配 `advertised.listeners` 为服务器局域网 IP，放行 9092，Java 11+ 检查。
- `deploy/install-trae-cli.md`：`irm https://trae.cn/trae-cli/install.ps1 | iex` → 登录企业账号 → `traecli` 验证。

### 阶段 5：端到端验证
- 见下方"验证方式"。

---

## 验证方式

**单机自测（无需第二台机器）**：
1. 在服务器按 `deploy/kafka-server-setup.md` 起 Kafka。
2. `npm install` → `npx tsx src/broker/createTopics.ts`。
3. `npm run selftest`（`tsx src/broker/selftest.ts`）—— 自动跑通 produce→consume→执行模拟→publish→consumeResults，断言结果正确。

**双机端到端**：
1. 服务器：按 `deploy/kafka-server-setup.md` 起 Kafka。3 台 TRAE 机器 `settings.env` 设 `KAFKA_BOOTSTRAP=<服务器IP>:9092`。
2. 机器 A：人工在 TRAE 里用 `orchestrator.md` 拆一个真实任务（例："给 repo X 加日志模块，B 写实现、C 写单测"），产出 2 个 task JSON 并 `npx tsx src/broker/produceTask.ts <file>` 分发。
3. 机器 B/C：装 trae-cli，`npm install && npm run build`，配 `settings.env`（`WORKER_ID=worker-B/C`），`npx tsx src/deploy/registerTasks.ts` 注册计划任务，间隔 2 分钟。
4. 观察：B/C 的 `inbox/` 出现任务 → `workspace/<task_id>/` 出现代码改动 → `outbox/` 出现 result → Kafka `agent-results` → A 的 `results/` 出现聚合结果。
5. 机器 A：人工在 TRAE 里读 `results/` 聚合，确认两个子任务都完成。

**排错**：`src/broker/` 各脚本均支持 `--verbose` 打印 Kafka 连接与消息；`state/processed.jsonl` 可查重放；`runtime/` 各目录可手动检查中间态。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| trae-cli 非交互模式在现场版本/账号下不可用 | `triggerTrae.ts` 可插拔降级为 IDE-UI 自动化；先在 1 台 worker 验证 `trae-cli run --file` 可跑通再铺开 |
| Kafka broker 单点 | 部署在服务器（Linux KRaft 最稳）；可后续扩为集群；客户端 KafkaJS 无需改 |
| token 失控 | 单任务单会话；inbox 空则不启动 trae-cli；`triggerTrae.ts` 设超时；result 记 token_usage |
| 计划任务并发重入 | `state/worker.lock` 独占文件锁 |
| 任务重复消费 | `state/processed.jsonl` 按 task_id 去重 + consumer group offset |
| 任务失败 | result `status=failed`，编排者可读后决定重发（重新 produceTask） |
| worker 离线 | Kafka 持久化，worker 上线后从 offset 续消费，不丢任务 |
| Node 未装/版本低 | `deploy/` 文档要求 Node 18+；可选打包为单文件（`pkg`/`esbuild`）免运行时 |

---

## 关键文件（实现时优先编写顺序）

1. `src/types.ts` + `src/config/settings.ts` + `package.json`/`tsconfig.json`（骨架）
2. `src/broker/kafkaHelper.ts` + `src/broker/createTopics.ts`（通信基座）
3. `src/broker/produceTask.ts` + `src/broker/consumeTasks.ts`（最小分发链路）
4. `src/broker/selftest.ts`（尽早验证闭环）
5. `src/triggers/triggerTrae.ts`（cli 模式）+ `src/triggers/workerPoll.ts`
6. `src/broker/publishResults.ts` + `src/broker/consumeResults.ts`（结果回传）
7. `skills/orchestrator.md` + `skills/worker_task_template.md`
8. `src/deploy/registerTasks.ts` + `deploy/*.md`（部署与计划任务注册）
9. `README.md` 收尾
 