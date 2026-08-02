import * as fs from 'fs';
import * as path from 'path';
import { consumeResults } from '../broker/consumeResults';
import { initAgentMiddlewares, emitAgentEvent } from '../agent';
import type { AgentContext } from '../agent';
import { loadSettings } from '../config/settings';
import { TaskResult } from '../types';

/**
 * 读取已上报过 hook 的 task_id 集合（去重，避免 orchestratorCollect 重复扫描时重复上报）。
 */
async function readHooked(): Promise<Set<string>> {
  const f = path.join(loadSettings().RUNTIME_DIR, 'state', 'hooked.jsonl');
  if (!fs.existsSync(f)) return new Set();
  const lines = (await fs.promises.readFile(f, 'utf8')).split('\n').filter(Boolean);
  return new Set(lines);
}

async function markHooked(taskId: string): Promise<void> {
  const f = path.join(loadSettings().RUNTIME_DIR, 'state', 'hooked.jsonl');
  await fs.promises.appendFile(f, taskId + '\n', 'utf8');
}

/**
 * Orchestrator 结果收集入口（供 Windows 计划任务周期调用）：
 * 1. 从 RESULTS_TOPIC 拉取结果并落盘到 results/ 目录
 * 2. 主 Agent 阶段推进 Hook：对每条新结果上报详情到黑盒后端（agent_role=orchestrator）
 */
export async function orchestratorCollect(): Promise<void> {
  const n = await consumeResults(20, 8000);
  console.log(`[orchestratorCollect] 收集 ${n} 条结果`);

  const settings = loadSettings();
  const resultsDir = path.join(settings.RUNTIME_DIR, 'results');
  if (!fs.existsSync(resultsDir)) return;

  const hooked = await readHooked();
  const files = (await fs.promises.readdir(resultsDir)).filter((f) =>
    f.endsWith('.result.json')
  );
  for (const f of files) {
    let r: TaskResult;
    try {
      r = JSON.parse(
        await fs.promises.readFile(path.join(resultsDir, f), 'utf8')
      ) as TaskResult;
    } catch {
      continue;
    }
    if (hooked.has(r.task_id)) continue;
    const ctx: AgentContext = {
      trace_id: r.trace_id,
      task_id: r.task_id,
      agent_role: 'orchestrator',
      worker_id: 'trae-a',
      event: 'stage_advanced',
      status: r.status,
      summary: r.summary,
      artifacts: r.artifacts,
      metrics: r.metrics,
      error: r.error,
      completed_at: r.completed_at,
    };
    try {
      await emitAgentEvent(ctx);
      await markHooked(r.task_id);
    } catch {
      /* 管道失败不阻断收集；下次 orchestratorCollect 会重试该 task_id */
    }
  }
}

if (require.main === module) {
  initAgentMiddlewares();
  orchestratorCollect().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
