import * as fs from 'fs';
import { TaskMessage } from '../types';
import { validateTaskMessage, ValidationError } from './validate';
import { createProducer, TASKS_TOPIC } from './kafkaHelper';

/**
 * 校验并将一条 TaskMessage 发送到 agent-tasks topic。
 * - 校验失败（ValidationError）：console.error 后 process.exit(1)
 * - 其它异常：原样向上抛出
 */
export async function produceTask(
  task: TaskMessage
): Promise<{ taskId: string; workerId: string; partition: number }> {
  try {
    validateTaskMessage(task);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`[produceTask] 校验失败: ${e.message}`);
      process.exit(1);
    } else {
      throw e;
    }
  }

  const producer = createProducer();
  await producer.connect();
  try {
    const meta = await producer.send({
      topic: TASKS_TOPIC,
      messages: [{ key: task.worker_id, value: JSON.stringify(task) }],
    });
    return {
      taskId: task.task_id,
      workerId: task.worker_id,
      partition: meta[0].partition,
    };
  } finally {
    await producer.disconnect();
  }
}

if (require.main === module) {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('[produceTask] 缺少参数: 请提供 task JSON 文件路径');
    process.exit(1);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(fileArg, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[produceTask] 读取文件失败: ${msg}`);
    process.exit(1);
  }

  let task: unknown;
  try {
    task = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[produceTask] JSON 解析失败: ${msg}`);
    process.exit(1);
  }

  produceTask(task as TaskMessage)
    .then((r) => {
      console.log(
        `[produceTask] task_id=${r.taskId} worker_id=${r.workerId} partition=${r.partition}`
      );
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[produceTask] 发送失败: ${msg}`);
      process.exit(1);
    });
}
