import * as fs from 'fs';
import * as path from 'path';
import { loadSettings } from '../config/settings';
import { validateTaskResult, writeToDLQ } from './validate';
import { createConsumer, runConsumer, RESULTS_TOPIC } from './kafkaHelper';

/**
 * 消费 RESULTS_TOPIC，将校验通过的结果按 task_id 落盘到 results/ 目录。
 * 解析或校验失败的消息写入 DLQ。达到 maxMessages 或 timeoutMs 后停止。
 *
 * @param maxMessages 最大处理条数（达到即返回）
 * @param timeoutMs 最长等待毫秒（超时即返回当前已处理数）
 * @returns 实际处理的消息条数
 */
export async function consumeResults(
  maxMessages = 20,
  timeoutMs = 8000
): Promise<number> {
  const settings = loadSettings();
  const resultsDir = path.join(settings.RUNTIME_DIR, 'results');
  await fs.promises.mkdir(resultsDir, { recursive: true });

  const consumer = createConsumer('orchestrator-results', RESULTS_TOPIC);

  let count = 0;
  let resolveDone!: (n: number) => void;
  const done = new Promise<number>((r) => {
    resolveDone = r;
  });

  // fire-and-forget：runConsumer 自身长跑，靠 done/timeout 中断
  runConsumer(
    consumer,
    async (msg) => {
      try {
        const r = validateTaskResult(msg);
        await fs.promises.writeFile(
          path.join(resultsDir, `${r.task_id}.result.json`),
          JSON.stringify(r, null, 2),
          'utf8'
        );
        console.log(`[consumeResults] task_id=${r.task_id} status=${r.status}`);
        count++;
        if (count >= maxMessages) resolveDone(count);
      } catch (e) {
        await writeToDLQ(
          RESULTS_TOPIC,
          msg,
          e instanceof Error ? e.message : String(e),
          settings.DLQ_DIR
        );
      }
    }
  ).catch(() => {});

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

/**
 * CLI 入口：打印本次消费处理的消息条数。
 */
async function main(): Promise<void> {
  const n = await consumeResults();
  console.log(`[consumeResults] processed=${n}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[consumeResults] failed:', err);
    process.exit(1);
  });
}
