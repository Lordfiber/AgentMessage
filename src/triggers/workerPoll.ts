import * as fs from 'fs';
import * as path from 'path';
import { EachMessagePayload } from 'kafkajs';
import { loadSettings } from '../config/settings';
import { consumeTasksForWorker } from '../broker/consumeTasks';
import { publishPendingResults } from '../broker/publishResults';
import { getKafka, CONTROL_TOPIC } from '../broker/kafkaHelper';
import { validateControlMessage } from '../broker/validate';
import { triggerTrae } from './triggerTrae';
import { TaskMessage, ControlMessage } from '../types';

/**
 * 检测 CONTROL_TOPIC 中针对本 worker 的最新控制信号。
 * 用临时 groupId（带时间戳）从 beginning 消费全部历史 control 消息，
 * 找出 worker_id 匹配本 worker 或 '*' 的最新一条，若 cmd === 'stop' 返回 true。
 *
 * 注：consumer.run 持续运行，done 永不 resolve，靠 3 秒超时收尾。
 */
async function checkStopSignal(workerId: string): Promise<boolean> {
  const kafka = getKafka();
  const consumer = kafka.consumer({ groupId: `ctrl-${workerId}-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: CONTROL_TOPIC, fromBeginning: true });

  // 用 ref 对象承载最新控制信号：属性访问不受 CFA 跨闭包收窄影响。
  const latestRef: { value: ControlMessage | null } = { value: null };
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  // fire-and-forget：避免 await consumer.run 阻塞主流程
  consumer
    .run({
      eachMessage: async ({ message }: EachMessagePayload) => {
        try {
          const c = validateControlMessage(
            JSON.parse(message.value?.toString() ?? '{}')
          );
          if (c.worker_id === workerId || c.worker_id === '*') {
            if (
              !latestRef.value ||
              c.issued_at > latestRef.value.issued_at
            ) {
              latestRef.value = c;
            }
          }
        } catch {
          /* ignore：跳过非法 control 消息 */
        }
      },
    })
    .catch(() => {
      /* ignore：靠 race 超时收尾 */
    });

  // done 永不 resolve，3 秒超时退出
  await Promise.race([done, new Promise<void>((r) => setTimeout(r, 3000))]);
  void resolveDone;

  try {
    await consumer.disconnect();
  } catch {
    /* ignore */
  }
  return latestRef.value?.cmd === 'stop';
}

/**
 * Worker 轮询入口（供 Windows 计划任务周期调用）：
 * 1. 校验 WORKER_ID
 * 2. 文件锁防重入（WORKER_LOCK，wx 创建）
 * 3. 检测 stop 控制信号
 * 4. 拉取任务到 inbox（consumeTasksForWorker）
 * 5. 逐个执行 triggerTrae 并发布结果（publishPendingResults）
 */
export async function workerPoll(): Promise<void> {
  const settings = loadSettings();
  const workerId = settings.WORKER_ID;
  if (!workerId) {
    console.error('WORKER_ID 未设置');
    process.exit(1);
  }

  // 文件锁防重入：wx 模式创建，已存在则抛 EEXIST
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(settings.WORKER_LOCK, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      console.log('[workerPoll] 另一实例运行中，退出');
      return;
    }
    throw e;
  }

  try {
    // 检测停止信号
    if (await checkStopSignal(workerId)) {
      console.log('[workerPoll] 收到 stop 信号，跳过本轮');
      return;
    }

    // 拉任务到 inbox
    const n = await consumeTasksForWorker(workerId, 5, 8000);

    if (n > 0) {
      const inboxDir = path.join(settings.RUNTIME_DIR, 'inbox');
      const files = (await fs.promises.readdir(inboxDir)).filter((f) =>
        f.endsWith('.json')
      );
      for (const f of files) {
        const task = JSON.parse(
          await fs.promises.readFile(path.join(inboxDir, f), 'utf8')
        ) as TaskMessage;
        console.log(`[workerPoll] 执行 ${task.task_id}`);
        try {
          await triggerTrae(task);
        } catch (e) {
          console.error(
            `[workerPoll] triggerTrae 失败 ${task.task_id}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
      await publishPendingResults(workerId);
    }

    console.log(`[workerPoll] 本轮处理 ${n} 个任务`);
  } finally {
    // 释放文件锁：先关闭 fd（Windows 下需先关句柄才能删除），再删除锁文件
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(settings.WORKER_LOCK);
    } catch {
      /* ignore */
    }
  }
}

if (require.main === module) {
  workerPoll().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
