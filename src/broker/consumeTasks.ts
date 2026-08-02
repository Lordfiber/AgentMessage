import * as fs from 'fs';
import * as path from 'path';
import { TaskMessage } from '../types';
import { validateTaskMessage, writeToDLQ } from './validate';
import { createConsumer, runConsumer, TASKS_TOPIC } from './kafkaHelper';
import { loadSettings } from '../config/settings';

/**
 * 将 TaskMessage 渲染为 worker 可读的 Markdown 任务说明。
 * 缺失的可选字段对应章节会被省略。
 */
export function renderTaskMarkdown(task: TaskMessage): string {
  const lines: string[] = [];

  lines.push(`# 任务 ${task.task_id}`);
  lines.push('');
  lines.push(`- worker: ${task.worker_id}`);
  lines.push(`- type: ${task.type}`);
  lines.push(`- 创建时间: ${task.created_at}`);
  lines.push('');

  // 目标（必填）
  lines.push('## 目标');
  lines.push(task.directive.objective);
  lines.push('');

  // 背景（可选）
  if (task.directive.background) {
    lines.push('## 背景');
    lines.push(task.directive.background);
    lines.push('');
  }

  // 上下文（可选）
  const refs = task.directive.context_refs;
  if (refs && refs.length > 0) {
    lines.push('## 上下文');
    for (const r of refs) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  // 执行步骤（必填）
  lines.push('## 执行步骤');
  task.directive.instructions.forEach((inst, i) => {
    lines.push(`${i + 1}. ${inst}`);
  });
  lines.push('');

  // 约束（可选）
  const c = task.directive.constraints;
  if (c) {
    const cLines: string[] = [];
    if (c.language) cLines.push(`- 语言: ${c.language}`);
    if (c.style) cLines.push(`- 风格: ${c.style}`);
    if (c.forbidden && c.forbidden.length > 0) {
      cLines.push(`- 禁止: ${c.forbidden.join(', ')}`);
    }
    if (cLines.length > 0) {
      lines.push('## 约束');
      lines.push(...cLines);
      lines.push('');
    }
  }

  // 验收标准（必填）
  lines.push('## 验收标准');
  for (const ac of task.directive.acceptance_criteria) {
    lines.push(`- ${ac}`);
  }
  lines.push('');

  // 工作目录（可选）
  if (task.workspace || task.workdir) {
    lines.push('## 工作目录');
    if (task.workspace) lines.push(`- workspace: ${task.workspace}`);
    if (task.workdir) lines.push(`- workdir: ${task.workdir}`);
    lines.push('');
  }

  // 预期产物（必填）
  lines.push('## 预期产物');
  for (const d of task.expected_output.deliverables) {
    lines.push(`- ${d}`);
  }
  lines.push('');

  // 结果提交（必填）
  lines.push('## 结果提交');
  lines.push(`完成后请将结果 JSON 写入：\`${task.expected_output.result_file}\``);
  lines.push('结果字段须符合：');
  lines.push('- status: "success" | "failed" | "partial"');
  lines.push('- summary: string');
  lines.push('- artifacts: string[]');
  const patchNote = task.expected_output.patch_required
    ? '必须提供 git diff'
    : '可为空';
  lines.push(`- patch: string（${patchNote}）`);
  lines.push(
    '- metrics: { duration_sec: number, token_usage: { input: number, output: number } }'
  );
  lines.push('- error: string（失败时填写，成功留空）');
  lines.push('');

  return lines.join('\n');
}

/**
 * 为指定 worker 消费任务消息：
 * - 订阅全分区，按 worker_id 客户端过滤；
 * - 基于磁盘文件（PROCESSED_FILE）做 task_id 去重；
 * - 每条任务渲染为 Markdown + 原始 JSON 落入 inbox 目录；
 * - 达到 maxMessages 或 timeoutMs 时收尾并返回处理条数。
 */
export async function consumeTasksForWorker(
  workerId: string,
  maxMessages = 5,
  timeoutMs = 8000
): Promise<number> {
  const settings = loadSettings();

  // 读取已处理 task_id 集合（每行一个 task_id），文件不存在则空集。
  async function loadProcessed(): Promise<Set<string>> {
    const set = new Set<string>();
    try {
      const content = await fs.promises.readFile(
        settings.PROCESSED_FILE,
        'utf8'
      );
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (t) set.add(t);
      }
    } catch {
      // 文件不存在 -> 空集
    }
    return set;
  }

  // 追加一个已处理 task_id（换行分隔）。
  async function appendProcessed(taskId: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(settings.PROCESSED_FILE), {
      recursive: true,
    });
    await fs.promises.appendFile(
      settings.PROCESSED_FILE,
      `${taskId}\n`,
      'utf8'
    );
  }

  const processed = await loadProcessed();

  const consumer = createConsumer(`worker-${workerId}`, TASKS_TOPIC);

  let count = 0;
  let resolveDone!: (n: number) => void;
  const done = new Promise<number>((r) => {
    resolveDone = r;
  });

  // fire-and-forget 启动消费，避免 await runConsumer 阻塞主流程。
  runConsumer(consumer, async (msg) => {
    try {
      const task = validateTaskMessage(msg);
      if (task.worker_id !== workerId) return; // 订阅全分区，客户端按 worker_id 过滤
      if (processed.has(task.task_id)) return; // 去重

      const md = renderTaskMarkdown(task);
      const inboxDir = path.join(settings.RUNTIME_DIR, 'inbox');
      await fs.promises.mkdir(inboxDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(inboxDir, `${task.task_id}.md`),
        md,
        'utf8'
      );
      await fs.promises.writeFile(
        path.join(inboxDir, `${task.task_id}.json`),
        JSON.stringify(task, null, 2),
        'utf8'
      );

      processed.add(task.task_id);
      await appendProcessed(task.task_id);
      count++;
      if (count >= maxMessages) resolveDone(count);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await writeToDLQ(TASKS_TOPIC, msg, reason, settings.DLQ_DIR);
    }
  }).catch(() => {
    /* 忽略，主流程靠 race 收尾 */
  });

  const n = await Promise.race([
    done,
    new Promise<number>((r) => setTimeout(() => r(count), timeoutMs)),
  ]);

  try {
    await consumer.disconnect();
  } catch {
    /* ignore */
  }

  return n;
}

// CLI 入口：argv[2] = worker_id
if (require.main === module) {
  const workerId = process.argv[2];
  if (!workerId) {
    console.error('[consumeTasks] missing argv[2]=worker_id');
    process.exit(1);
  }
  consumeTasksForWorker(workerId)
    .then((n) => {
      console.log(`[consumeTasks] processed=${n}`);
    })
    .catch((err) => {
      console.error('[consumeTasks] failed:', err);
      process.exit(1);
    });
}
