import * as fs from 'fs';
import * as path from 'path';
import { loadSettings } from '../config/settings';
import { validateTaskResult, writeToDLQ } from './validate';
import { createProducer, sendJSON, RESULTS_TOPIC } from './kafkaHelper';

/**
 * 扫描 outbox 目录下所有 *.result.json 文件，校验后发布到 RESULTS_TOPIC，
 * 已发送文件移动到 _sent/ 子目录；解析或校验失败的写入 DLQ。
 *
 * @param workerId 保留用于日志（结果消息自带 worker_id，此处不强校验）
 * @returns 成功发布的消息条数
 */
export async function publishPendingResults(workerId: string): Promise<number> {
  const settings = loadSettings();
  const outboxDir = path.join(settings.RUNTIME_DIR, 'outbox');
  const sentDir = path.join(outboxDir, '_sent');

  let files: string[] = [];
  try {
    files = (await fs.promises.readdir(outboxDir)).filter((f) =>
      f.endsWith('.result.json')
    );
  } catch {
    // 目录不存在：无待发消息
    return 0;
  }
  if (files.length === 0) return 0;

  await fs.promises.mkdir(sentDir, { recursive: true });

  const producer = createProducer();
  await producer.connect();
  let count = 0;
  try {
    for (const f of files) {
      const raw = await fs.promises.readFile(path.join(outboxDir, f), 'utf8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        await writeToDLQ(
          RESULTS_TOPIC,
          raw,
          `JSON parse: ${e instanceof Error ? e.message : String(e)}`,
          settings.DLQ_DIR
        );
        continue;
      }

      try {
        validateTaskResult(parsed);
      } catch (e) {
        await writeToDLQ(
          RESULTS_TOPIC,
          parsed,
          e instanceof Error ? e.message : String(e),
          settings.DLQ_DIR
        );
        continue;
      }

      await sendJSON(
        producer,
        RESULTS_TOPIC,
        parsed,
        (parsed as { task_id: string }).task_id
      );
      await fs.promises.rename(path.join(outboxDir, f), path.join(sentDir, f));
      count++;
    }
  } finally {
    await producer.disconnect();
  }

  // workerId 当前仅保留用于未来日志扩展，避免未使用告警
  void workerId;
  return count;
}

/**
 * CLI 入口：打印本次发布的消息条数。
 */
async function main(): Promise<void> {
  const workerId = process.env.WORKER_ID ?? 'orchestrator';
  const n = await publishPendingResults(workerId);
  console.log(`[publishResults] published=${n} workerId=${workerId}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[publishResults] failed:', err);
    process.exit(1);
  });
}
