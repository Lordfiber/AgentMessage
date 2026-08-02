// Agent 统一管理层 · 生命周期管道
// ─────────────────────────────────────────────────────────────
// 所有 agent（主 Agent / 5 个角色 Agent）的生命周期事件都经过这个中间件管道。
// 横切关注点（hook 上报 / 评审 / 总结 / 审计 / token 统计...）注册为中间件：
//   加新关注点 = useAgentMiddleware(xxx) 一行，零改动现有 agent 代码。
//
// 这是解决"每个 agent 后面都加一段一模一样的逻辑"的冗余问题的核心抽象：
//   以前：workerPoll 调 hook、orchestratorCollect 调 hook、未来还要各调评审/总结...
//   现在：所有 agent 只调 emitAgentEvent(ctx)，中间件管道统一分发。

import type { AgentRole, TaskStatus, TaskType } from '../types';

/** Agent 生命周期事件类型（可扩展：加新事件在这里加一行） */
export type AgentLifecycleEvent =
  | 'task_started' // agent 开始处理任务
  | 'task_completed' // agent 完成任务（成功/失败/部分）
  | 'stage_advanced' // 主 agent 阶段推进（收到子任务结果）
  | 'review_passed' // （未来）评审通过
  | 'review_rejected' // （未来）评审驳回
  | 'summarized'; // （未来）总结完成

/** 统一上下文：所有中间件共享这一份，字段是各关注点的超集 */
export interface AgentContext {
  trace_id?: string;
  task_id: string;
  parent_task_id?: string;
  agent_role: AgentRole;
  worker_id: string;
  stage?: TaskType | 'input';
  event: AgentLifecycleEvent;
  status?: TaskStatus;
  summary?: string;
  artifacts?: string[];
  metrics?: { duration_sec: number; token_usage: { input: number; output: number } };
  error?: string;
  completed_at: string;
}

/** 中间件：一个关注点 = 一个处理器 */
export type AgentMiddleware = (ctx: AgentContext) => Promise<void>;

const middlewares: AgentMiddleware[] = [];

/** 注册中间件（幂等：同名中间件不重复注册） */
const registered = new Set<string>();
export function useAgentMiddleware(name: string, mw: AgentMiddleware): void {
  if (registered.has(name)) return;
  registered.add(name);
  middlewares.push(mw);
}

/**
 * 发射 agent 生命周期事件 → 依次跑所有中间件。
 * - 任一中间件抛错都被吞掉（只记日志），不影响后续中间件 / 主链路。
 * - agent 代码只调这一个函数，不直接调 hook/评审/总结。
 */
export async function emitAgentEvent(ctx: AgentContext): Promise<void> {
  for (const mw of middlewares) {
    try {
      await mw(ctx);
    } catch (err) {
      console.error(
        `[agent-lifecycle] middleware failed for ${ctx.event} ${ctx.task_id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
