# AgentPulse · TRAE 插件 UI 设计（多 Agent 任务分发看板）

> 运行环境：TRAE IDE（基于 VS Code / Code-OSS，兼容标准扩展 API：TreeView / Webview / StatusBar / Notification）。
> 数据来源：Orchestrator 侧事件流（`runtime/events/live.jsonl`，格式见 `docs/data-contracts.md` §11）。
> 本文件是 **UI 设计稿**（信息架构 + 布局 + 交互 + 数据绑定），不含完整实现代码。

---

## 1. 产品定位

**一句话**：让 Orchestrator 用户在 TRAE 里实时看到自己"发出去的任务"的全生命周期——消息是否发出、状态怎么流转、卡在哪个门禁、谁在回退重做。

| 维度 | 说明 |
|------|------|
| 目标用户 | Orchestrator（TRAE-A）操作者；其他 TRAE 可经远程推送只读围观 |
| 核心价值 | 不再翻 inbox/results/终端日志，状态一眼可见 |
| 交互基调 | **只读为主 + 点击跳转**；写操作（放行/重试）保守提供并二次确认 |
| 视觉基调 | 跟随 TRAE 深色主题（暗底 #0f172a 系），状态用色与架构文档一致 |

**四个视图组成**：① 活动栏 + 侧边栏 TreeView「链路」② Webview 看板「流水线」③ 状态栏 ④ 通知中心。

---

## 2. 信息架构

```
AgentPulse
├── ① 活动栏（左侧图标，展开侧边栏）
│   └── 视图容器 agentPulse
│       ├── 链路（trace 树：按 trace_id 分组，子节点=阶段/任务）
│       └── 待办/消息（未处理任务 + 最近事件）
├── ② Webview 看板「流水线」（命令：AgentPulse: 打开看板）
│   ├── 统计条（活跃链路 / 待办 / 失败 / token）
│   ├── 五子泳道（pm→dev→review→qa→deploy 横向；门禁 + 回退箭头）
│   ├── 团队层切换（多团队时按 team 分页）
│   └── 事件流（最新 N 条，可筛选）
├── ③ 状态栏（常驻：活跃/待办/失败计数，单击开看板）
└── ④ 通知中心（关键事件弹通知：成功/失败/门禁/回退，带去重节流）
```

---

## 3. 侧边栏 TreeView「链路」

### 3.1 线框图

```
┌────────────────────────────────────┐
│ 🚀 AgentPulse            [⟳][＋][⚙] │  ← 视图标题（工具栏：刷新/新建链路/设置）
├────────────────────────────────────┤
│ ▼ tr-20260803-0001 · 云门禁→结构化日志 │ ← trace 根节点：需求摘要
│   ├─ PM       ✅  已完成             │
│   ├─ Dev      🔄  2/3 执行中         │
│   │   ├─ dev t-…-0002  ✅ worker-B   │
│   │   ├─ dev t-…-0003  🔄 worker-B   │ ← 当前执行中（脉冲动画）
│   │   └─ dev t-…-0004  ⏸ 待处理      │
│   ├─ Review   ⏸  排队中              │
│   ├─ QA       ⏸  占位                │
│   └─ Deploy   ⏸  占位                │
│ ▼ tr-20260802-0007 · 车行云→门禁改造  │
│   └─ Dev      ↩  回退重做 2/3        │ ← 回退徽标 + 轮次
│ ⚠ 失败 1 · 📭 待处理 3 · 🔴 Hook 异常 │ ← 底部统计条（实时）
└────────────────────────────────────┘
```

### 3.2 节点规则

| 节点 | 图标 | 说明 |
|------|------|------|
| trace 根节点 | `📄` + trace_id 尾部 + 需求摘要 | 子节点按状态机阶段排序；右上角显示总进度 `3/5` |
| 阶段节点 | PM/Dev/Review/QA/Deploy 文字 + 状态色 | 点击可折叠展开该阶段任务 |
| 任务节点 | `dev t-…-0002` + worker 徽标 | 显示 `task_id 简写` + `worker_id` + 状态 |
| 待办/消息视图 | 未消费任务 / 最新事件 | 与「链路」并列的第二个 TreeView |

### 3.3 右键菜单（context menu）

| 菜单项 | 动作 |
|--------|------|
| 打开任务文件 | 打开 `inbox/<task_id>.md`（trae-cli 输入文件） |
| 查看结果 | 打开 `runtime/results/<task_id>.json` |
| 复制 trace_id | 复制链路 ID（便于查 Hook/日志） |
| 在流水线看板定位 | 跳转 Webview 对应链路并高亮 |
| 暂停/恢复（团队任务） | 写 `agent-control`（**需二次确认**，仅团队/主 Agent 显示） |

---

## 4. Webview 看板「流水线」

### 4.1 线框图

```
┌──────────────────────────────────────────────────────────────────┐
│ AgentPulse · 流水线                    [团队▼][链路▼][筛选: 全部] [⟳] │
├──────────────────────────────────────────────────────────────────┤
│ 活跃 2 │ 待办 3 │ 失败 1 │ 回退 1 │ ⚡token 今日 12.4k（≈1234+…）   │ ← 统计条
├──────────────────────────────────────────────────────────────────┤
│ ▼ tr-20260803-0001 · 云门禁 → 结构化日志              [3/5 阶段]     │
│   ┌─────┐  🛂  ┌─────┐      ┌───────┐  🛂  ┌─────┐  🛂  ┌───────┐ │
│   │  PM │──→──│ Dev │──────→│Review │──→──│ QA  │──→──│Deploy │ │
│   │  ✅  │ 通过 │ 🔄 │  评审  │  ⏸  │  占位 │  ⏸  │  占位 │  ⏸  │ │
│   │ PRD │     │ 2/3 │       │ 排队  │      │     │      │     │ │
│   └─────┘     └──┬──┘       └───────┘      └─────┘      └───────┘ │
│                  │  ↺ 回退 1/3（review 驳回 → dev 重做）            │
│                  └──────────────────┐                              │
│   [任务卡 hover 浮层：task_id/worker/status/token]                  │
│ ▼ tr-20260802-0007 · 车行云 → 门禁改造                 [2/5 阶段]     │
│   ┌─────┐  🛂  ┌─────┐      ┌───────┐                             │
│   │  PM │──→──│ Dev │──────→│Review │…（同构）                     │
│   │  ✅  │ 通过 │ ↩ 1/3│ 打回 │  ⏸  │                             │
│   └─────┘     └─────┘      └───────┘                             │
├──────────────────────────────────────────────────────────────────┤
│ 事件流（最新 12）              [全部|成功|失败|门禁|回退]  [跟随]     │
│ 09:05:27  ✅ stage_progress  t-…-0003 dev 完成（worker-B）          │
│ 09:04:01  🛂 gate_passed     tr-…-0001 门禁① PRD 评审通过           │
│ 09:02:55  ↩ stage_rolled_back tr-…-0007 review 驳回 → dev 重做     │
│ 09:02:10  📥 produced        t-…-0007 dev 任务已投递               │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 泳道卡片（任务卡）字段

| 区块 | 内容 |
|------|------|
| 标题 | `角色名` + 阶段徽标（PM/Dev/Review/QA/Deploy） |
| 状态区 | 状态图标 + 色块背景（见 §5 映射） |
| 详情区 | `task_id` 简写 · `worker_id` 徽标 · 进度（dev 显示 `2/3`）· 耗时 |
| 回退区（仅 dev） | `↩ 重做 n/3` 橙色徽标 |
| 门禁节点 | 阶段之间 `🛂` 图标 + `通过/拒绝/等待` 状态 |

### 4.3 交互

| 交互 | 行为 |
|------|------|
| 点击任务卡 | 打开对应 `inbox/<task_id>.md`（Ctrl+点击 打开 result.json） |
| 悬停任务卡 | 浮层显示完整字段（含 token_usage、error） |
| 点击回退箭头 | 展开回退详情（谁驳回/第几轮/问题清单前 3 条） |
| 统计条点击 | 跳到对应筛选（失败 1 → 事件流过滤 failed） |
| 事件流点击 | 复制该行事件 JSON（调试用） |
| 跟随开关 | 打开时自动滚动到最新事件 |

---

## 5. 状态 → 颜色 / 图标映射（全局统一）

| status | 色 | 图标 | 含义 | 触发事件 |
|--------|-----|------|------|----------|
| `pending` | 灰 `#64748b` | ⏸ | 待处理/排队 | `produced` |
| `running` | 蓝 `#38bdf8`（脉冲动画） | 🔄 | 执行中 | `consumed` / `running` |
| `success` | 绿 `#34d399` | ✅ | 完成 | `agent_complete` / `stage_progress` |
| `failed` | 红 `#f87171` | ❌ | 失败 | `agent_complete(status=failed)` |
| `partial` | 黄 `#fbbf24` | ⚠️ | 部分完成 | `agent_complete(status=partial)` |
| `gated` | 紫 `#a78bfa` | 🛂 | 门禁等待/拒绝 | `gate_rejected` / `gate_passed` |
| `rolled_back` | 橙 `#fb923c` | ↩ | 回退重做 | `stage_rolled_back` |
| `escalated` | 红描边 `#ef4444` | 🆘 | 升级人工 | `escalated` |

> 与 `docs/architecture.html`、`docs/data-contracts.md` §6.2 的事件语义一一对应，保证"事件 → 状态 → 颜色"整条链路可追溯。

---

## 6. 组件 ↔ 数据字段映射

| UI 组件 | 数据来源（UIEvent 字段） |
|---------|--------------------------|
| 链路树根节点 | `trace_id` + `summary`（取该 trace 首条事件的 objective） |
| 阶段节点 | `stage` + `route_path` 段 |
| 任务节点 | `task_id` + `worker_id` + `agent_role` + `status` |
| 泳道卡片 | `agent_role` + `status` + `metrics.token_usage` + `ts` |
| 回退徽标 | `event=stage_rolled_back` 的计数（按 `(trace_id, stage)` 累计） |
| 门禁图标 | `event=gate_passed/gate_rejected` |
| 统计条 | 内存聚合：按 `status` 计数；token 按 `metrics.token_usage` 累加 |
| 事件流 | 最新 N 条 `UIEvent`（`ts` 倒序） |
| 状态栏 | 活跃链路数 / 待办数 / 失败数（同统计条） |

---

## 7. 状态栏 + 通知中心

### 7.1 状态栏（常驻）

```
┌─ 状态栏 ───────────────────────────────────────────────────┐
│ 🚀 2 活跃 · 3 待办 · 1 失败         AgentPulse · 单击打开看板 │
│ ▲ Hook 异常（2 条待补发）← 仅异常时出现，红色                │
└────────────────────────────────────────────────────────────┘
```

- 左段：`$(rocket) 2 活跃 · 3 待办 · 1 失败`，**单击** → 打开 Webview 看板；**右键** → 刷新 / 暂停通知
- 右段：插件名 + 连接状态（`● 本地流` / `● 远程流` / `○ 断线`）
- 异常提示：`runtime/hooks/_failed/` 有积压时显示红色计数

### 7.2 通知中心（右下角弹窗）

| 事件 | 通知 | 动作按钮 |
|------|------|----------|
| `stage_progress`(success) | `✅ dev 完成：t-…-0003（worker-B）` | [查看] → 打开看板该链路 |
| `failed` / `escalated` | `❌ 任务失败 / 🆘 已升级人工：…` | [查看] [重试]（二次确认） |
| `gate_passed` / `gate_rejected` | `🛂 门禁① 通过 / 拒绝：…` | [定位] |
| `stage_rolled_back` | `↩ 回退：review 驳回 dev 重做（2/3）` | [查看] |
| Hook 异常 | `🔴 Hook 上报失败，已落本地待补发` | [打开 _failed] |

**去重节流规则**：同一 `trace_id` 同类事件 **30s 内只弹一次**；`stage_progress` 默认只在看板事件流滚动展示，不弹通知（可配置"仅失败/门禁/回退弹窗"）。

---

## 8. 数据接入

```
TRAE 插件进程（Node 侧）
├── eventSource.ts
│   ├── P0: fs.watch(runtime/events/live.jsonl) + 断点续读（offset 记录在插件 globalState）
│   └── P1: SSE 订阅 {AGENT_EVENT_URL}/sse?since=<ts>（配置 agentPulse.remoteUrl 时启用）
├── traceStore.ts        # 事件 → 链路树内存模型（重放快照 + 增量更新，触发视图刷新）
└── 视图层               # TreeView / Webview / StatusBar / Notification 订阅 traceStore
```

- **启动**：重放 `live.jsonl` 全量重建 → 视图就绪 → 增量订阅
- **断线恢复**：本地文件按 offset 续读；SSE 按 `since` 重连
- **配置项**：`agentPulse.runtimeDir`（默认项目根 `./runtime`）、`agentPulse.remoteUrl`（可选 SSE）、`agentPulse.notify`（弹窗开关）
- **写操作边界**：插件默认只读；仅"暂停/恢复/重试"等命令写 `agent-control` 主题或触发脚本，且必须二次确认

---

## 9. 插件工程结构（概要）

```
extensions/agent-pulse/
├── package.json            # 清单：contributes 视图/命令/配置（见下）
├── src/
│   ├── extension.ts        # activate：注册命令/视图/状态栏/通知，装配 traceStore
│   ├── eventSource.ts      # P0 本地文件监听 + P1 SSE（§8）
│   ├── traceStore.ts       # 事件 → 链路树模型（快照 + 增量 + 幂等去重）
│   ├── notify.ts           # 通知中心（去重节流规则 §7.2）
│   └── views/
│       ├── traceTree.ts    # TreeView 数据提供器（§3）
│       ├── dashboard/      # Webview 看板（HTML/CSS/JS，§4）
│       └── statusBar.ts    # 状态栏（§7.1）
└── media/rocket.svg        # 活动栏/状态栏图标
```

**package.json contributes 摘要**（TRAE 兼容 VS Code 扩展模型）：

```jsonc
{
  "name": "agent-pulse",
  "displayName": "AgentPulse · 多 Agent 任务分发看板",
  "engines": { "vscode": "^1.96.0" },   // TRAE 基于 ~1.96
  "contributes": {
    "viewsContainers": { "activitybar": [{ "id": "agentPulse", "title": "AgentPulse", "icon": "media/rocket.svg" }] },
    "views": {
      "agentPulse": [
        { "id": "agentPulse.traces", "name": "链路" },
        { "id": "agentPulse.inbox",  "name": "待办 / 消息" }
      ]
    },
    "commands": [
      { "command": "agentPulse.openDashboard", "title": "AgentPulse: 打开流水线看板" },
      { "command": "agentPulse.openTaskFile", "title": "打开任务文件" },
      { "command": "agentPulse.openResult",   "title": "查看结果" },
      { "command": "agentPulse.refresh",      "title": "刷新" }
    ],
    "menus": { "view/item/context": [ /* §3.3 右键菜单 */ ] },
    "configuration": { "properties": { /* §8 配置项 */ } }
  }
}
```

打包：`vsce package` → 生成 `.vsix` → TRAE「扩展 → 从 VSIX 安装」。

---

## 10. 里程碑

| 里程碑 | 范围 | 依赖 |
|--------|------|------|
| **M1 · 事件流 + 链路树** | `uiMiddleware` 写 `live.jsonl`；插件 P0 监听；TreeView「链路」+ 状态栏 | `docs/data-contracts.md` §11 落地（中间件⑥待实现） |
| **M2 · 流水线看板** | Webview 泳道图 + 事件流 + 统计条 + 点击跳转 | M1 |
| **M3 · 通知与远程** | 通知中心（去重节流）+ P1 SSE 跨机围观 + 写操作（control） | M1/M2 |
