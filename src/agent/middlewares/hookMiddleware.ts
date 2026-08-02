// 中间件① · Hook 上报（把 agent 完成详情 POST 到黑盒后端）
// 收拢自原先散落在 workerPoll / orchestratorCollect 里的 reportAgentComplete 调用。

import type { AgentContext, AgentMiddleware } from '../lifecycle';
import { reportAgentComplete } from '../../broker/hookReport';
import type { HookPayload } from '../../types';

function ctxToHookPayload(ctx: AgentContext): HookPayload {
  return {
    event: ctx.event === 'stage_advanced' ? 'stage_progress' : 'agent_complete',
    trace_id: ctx.trace_id,
    task_id: ctx.task_id,
    parent_task_id: ctx.parent_task_id,
    agent_role: ctx.agent_role,
    worker_id: ctx.worker_id,
    stage: ctx.stage,
    status: ctx.status ?? 'success',
    summary: ctx.summary,
    artifacts: ctx.artifacts,
    metrics: ctx.metrics,
    error: ctx.error,
    completed_at: ctx.completed_at,
  };
}

/**
 * 只对"完成/推进"事件上报 hook；started 等事件不上报（避免噪音）。
 * reportAgentComplete 内部已有"未配置=no-op / 失败落本地"兜底，这里不再包 try-catch。
 */
export const hookMiddleware: AgentMiddleware = async (ctx) => {
  if (ctx.event !== 'task_completed' && ctx.event !== 'stage_advanced') return;
  await reportAgentComplete(ctxToHookPayload(ctx));
};
