// Agent 统一管理层 · 中间件注册中心
// ─────────────────────────────────────────────────────────────
// 所有横切关注点在这里注册。加新关注点 = 取消注释 / 加一行 useAgentMiddleware。
// 这是"未来加评审/总结不冗余"的关键：只改这一个文件，不碰任何 agent 代码。

import { useAgentMiddleware } from '../lifecycle';
import { hookMiddleware } from './hookMiddleware';

let initialized = false;

/** 注册所有内置中间件（幂等，程序入口调一次） */
export function initAgentMiddlewares(): void {
  if (initialized) return;
  initialized = true;

  // ① Hook 上报（已完成 → POST 黑盒后端）
  useAgentMiddleware('hook', hookMiddleware);

  // ② 评审中间件（TODO）：对 dev 产出自动触发 review 角色，或人工评审门禁
  // useAgentMiddleware('review', reviewMiddleware);

  // ③ 总结中间件（TODO）：阶段收口后自动生成总结 → 知识库 ingest
  // useAgentMiddleware('summary', summaryMiddleware);

  // ④ 审计中间件（TODO）：全量事件落本地审计日志
  // useAgentMiddleware('audit', auditMiddleware);

  // ⑤ token 统计中间件（TODO）：按 trace_id / agent_role 聚合 token 消耗
  // useAgentMiddleware('token-stat', tokenStatMiddleware);
}
