// 端到端契约自检：连真实 Kafka 跑一次 task -> result 的往返，
// 不调 trae-cli，用模拟执行（手动构造 TaskResult 写到 outbox）。

import * as fs from 'fs';
import * as path from 'path';
import { TaskMessage, TaskResult } from '../types';
import { loadSettings } from '../config/settings';
import { kafkaCreateTopics } from './kafkaHelper';
import { produceTask } from './produceTask';
import { consumeTasksForWorker } from './consumeTasks';
import { publishPendingResults } from './publishResults';
import { consumeResults } from './consumeResults';
import {
  validateTaskMessage,
  validateTaskResult,
  ValidationError,
  writeToDLQ,
} from './validate';

/**
 * 断言辅助：条件不成立时抛出带前缀的 Error。
 */
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('selftest 断言失败: ' + msg);
}

/**
 * 列出 DLQ 目录下文件；目录不存在时返回空数组。
 */
async function listDlqFiles(dlqDir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dlqDir);
  } catch {
    return [];
  }
}

/**
 * 端到端契约往返自检：
 * 1. 建 topic -> 投递合法 task -> worker 消费渲染 inbox/.md
 * 2. 模拟执行写 outbox/.result.json -> 发布到 agent-results -> 消费落 results/
 * 3. 校验结果字段齐全
 * 4. 死信测试：非法 task（缺 directive）触发 ValidationError 并落 DLQ
 */
export async function selftest(): Promise<void> {
  const settings = loadSettings();
  console.log('[selftest] bootstrap...');

  // 1+2. 建主题
  await kafkaCreateTopics();

  // 3. 构造合法 TaskMessage
  const taskId = `selftest-${Date.now()}`;
  const nowIso = new Date().toISOString();
  const resultFile = path.join(
    settings.RUNTIME_DIR,
    'outbox',
    `${taskId}.result.json`
  );
  const task: TaskMessage = {
    schema_version: '1.0',
    task_id: taskId,
    worker_id: 'selftest-worker',
    type: 'dev',
    created_at: nowIso,
    directive: {
      objective: 'selftest 目标',
      instructions: ['步骤1', '步骤2'],
      acceptance_criteria: ['验收1'],
    },
    workspace: process.cwd(),
    expected_output: {
      deliverables: ['README.md'],
      result_file: resultFile,
      result_schema: {
        status: 'success',
        summary: 'string',
        artifacts: ['README.md'],
        patch: '',
        metrics: { duration_sec: 0, token_usage: { input: 0, output: 0 } },
        error: '',
      },
      patch_required: false,
    },
  };

  // 4. 投递到 agent-tasks
  await produceTask(task);

  // 5. 拉到 inbox 并渲染 .md
  const n = await consumeTasksForWorker('selftest-worker', 1, 8000);
  assert(n >= 1, '未消费到任务');

  // 6. 校验 inbox/<task_id>.md 含三节
  const inboxMd = await fs.promises.readFile(
    path.join(settings.RUNTIME_DIR, 'inbox', `${taskId}.md`),
    'utf8'
  );
  assert(inboxMd.includes('## 目标'), 'inbox md 缺少 ## 目标');
  assert(inboxMd.includes('## 执行步骤'), 'inbox md 缺少 ## 执行步骤');
  assert(inboxMd.includes('## 验收标准'), 'inbox md 缺少 ## 验收标准');

  // 7. 模拟执行：构造符合附录 B 的 TaskResult，写到 outbox
  const result: TaskResult = {
    schema_version: '1.0',
    task_id: taskId,
    worker_id: 'selftest-worker',
    status: 'success',
    summary: 'selftest 模拟完成',
    artifacts: ['README.md'],
    patch: '',
    metrics: { duration_sec: 1, token_usage: { input: 10, output: 5 } },
    error: '',
    completed_at: new Date().toISOString(),
  };
  await fs.promises.mkdir(path.dirname(resultFile), { recursive: true });
  await fs.promises.writeFile(resultFile, JSON.stringify(result, null, 2), 'utf8');

  // 8. 发布到 agent-results
  const p = await publishPendingResults('selftest-worker');
  assert(p >= 1, '未发布结果');

  // 9. 拉到 runtime/results/
  const r = await consumeResults(1, 8000);
  assert(r >= 1, '未消费到结果');

  // 10. 校验结果文件
  const resultJsonPath = path.join(
    settings.RUNTIME_DIR,
    'results',
    `${taskId}.result.json`
  );
  const resultRaw = await fs.promises.readFile(resultJsonPath, 'utf8');
  const parsedResult: unknown = JSON.parse(resultRaw);
  const validated = validateTaskResult(parsedResult);
  assert(validated.status === 'success', 'result status !== success');
  assert(typeof validated.summary === 'string', 'result summary 缺失');
  assert(Array.isArray(validated.artifacts), 'result artifacts 缺失');
  assert(typeof validated.metrics === 'object', 'result metrics 缺失');
  assert(typeof validated.completed_at === 'string', 'result completed_at 缺失');

  // 11. 死信测试：构造缺 directive 的非法 task
  const dlqBefore = await listDlqFiles(settings.DLQ_DIR);
  const bad: Record<string, unknown> = {
    schema_version: '1.0',
    task_id: `selftest-bad-${Date.now()}`,
    worker_id: 'selftest-worker',
    type: 'dev',
    created_at: new Date().toISOString(),
    expected_output: {
      deliverables: ['README.md'],
      result_file: path.join(settings.RUNTIME_DIR, 'outbox', 'bad.result.json'),
      result_schema: {
        status: 'success',
        summary: '',
        artifacts: [],
        patch: '',
        metrics: { duration_sec: 0, token_usage: { input: 0, output: 0 } },
        error: '',
      },
      patch_required: false,
    },
    // directive 故意缺失
  };
  let threw = false;
  try {
    validateTaskMessage(bad);
  } catch (e) {
    threw = true;
    assert(e instanceof ValidationError, '非法消息未抛出 ValidationError');
    const errMsg = e instanceof Error ? e.message : String(e);
    await writeToDLQ('agent-tasks', bad, errMsg, settings.DLQ_DIR);
    const dlqAfter = await listDlqFiles(settings.DLQ_DIR);
    assert(dlqAfter.length > dlqBefore.length, 'DLQ 目录无新文件');
  }
  if (!threw) throw new Error('非法消息未被发现');

  // 12. 全部通过
  console.log('[selftest] ALL PASS ✅');
}

// CLI 入口
if (require.main === module) {
  selftest().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[selftest] failed:', msg);
    process.exit(1);
  });
}
