// Agent 完成 Hook：任务完成后把详情 POST 到黑盒后端。
// - 每个 agent（Orchestrator 主 Agent + 5 个角色 Agent）完成任务后都调用一次。
// - 黑盒后端实现任意（审计 / 监控 / BI / 数据仓库），系统侧只约定接口。
// - AGENT_HOOK_URL 未配置 → no-op；POST 失败 → 落 runtime/hooks/_failed/，不中断主流程。

import * as fs from 'fs';
import * as path from 'path';
import { loadSettings } from '../config/settings';
import { HookPayload } from '../types';

const HOOK_TIMEOUT_MS = 10_000;

function failedDir(): string {
  return path.join(loadSettings().RUNTIME_DIR, 'hooks', '_failed');
}

/**
 * 上报 Agent 完成详情到黑盒后端。
 * - 未配置 AGENT_HOOK_URL → 直接返回（no-op）
 * - POST 失败/超时 → 把 payload 写入 runtime/hooks/_failed/<ts>-<task_id>.json，不抛错
 *
 * @param payload  完成详情；event=agent_complete（角色 agent）/ stage_progress（主 agent 阶段推进）
 */
export async function reportAgentComplete(payload: HookPayload): Promise<void> {
  const { AGENT_HOOK_URL: url } = loadSettings();
  if (!url) return; // 未配置，no-op

  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`hook HTTP ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    // 失败落本地，不中断主流程
    try {
      const dir = failedDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const stamp = `${Date.now()}-${payload.task_id || 'unknown'}`;
      const file = path.join(dir, `${stamp}.json`);
      const envelope = JSON.stringify(
        { failed_at: new Date().toISOString(), url, error: err instanceof Error ? err.message : String(err), payload },
        null,
        2
      );
      await fs.promises.writeFile(file, envelope, 'utf8');
    } catch {
      /* 连落盘都失败，只能吞掉，绝不影响主链路 */
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 便捷构造：从 TaskMessage + TaskResult 组装角色 agent 的完成 payload。
 * 用于 worker 侧（triggerTrae 跑完之后）。
 */
export function buildAgentCompletePayload(
  task: { task_id: string; trace_id?: string; parent_task_id?: string; worker_id: string; type: import('../types').TaskType },
  result: { status: import('../types').TaskStatus; summary?: string; artifacts?: string[]; metrics?: HookPayload['metrics']; error?: string; completed_at?: string }
): HookPayload {
  return {
    event: 'agent_complete',
    trace_id: task.trace_id,
    task_id: task.task_id,
    parent_task_id: task.parent_task_id,
    agent_role: task.type,
    worker_id: task.worker_id,
    stage: task.type,
    status: result.status,
    summary: result.summary,
    artifacts: result.artifacts,
    metrics: result.metrics,
    error: result.error,
    completed_at: result.completed_at ?? new Date().toISOString(),
  };
}

/**
 * CLI 入口：
 *   npx tsx src/broker/hookReport.ts <payload.json>
 * 用于人工补发或独立测试。
 */
async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write('Usage: npx tsx src/broker/hookReport.ts <payload.json>\n');
    process.exit(1);
  }
  const payload = JSON.parse(await fs.promises.readFile(arg, 'utf8')) as HookPayload;
  await reportAgentComplete(payload);
  process.stdout.write('hook reported.\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`hookReport failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
