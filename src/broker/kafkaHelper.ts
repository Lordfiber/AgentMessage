import { Kafka, Producer, Consumer, EachMessagePayload } from 'kafkajs';
import { loadSettings } from '../config/settings';

export const SCHEMA_VERSION = '1.0';

export const TASKS_TOPIC = 'agent-tasks';
export const RESULTS_TOPIC = 'agent-results';
export const CONTROL_TOPIC = 'agent-control';

const settings = loadSettings();

const clientId = `agent-message-${settings.WORKER_ID || 'orchestrator'}`;

/**
 * 单例 Kafka 客户端（同进程内复用）。
 */
let _kafka: Kafka | null = null;
export function getKafka(): Kafka {
  if (!_kafka) {
    _kafka = new Kafka({
      clientId,
      brokers: settings.KAFKA_BOOTSTRAP
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return _kafka;
}

/**
 * 创建一个生产者（每次新建；调用方负责 connect/disconnect）。
 */
export function createProducer(): Producer {
  return getKafka().producer();
}

/**
 * 向指定 topic 发送一条 JSON 消息。
 * value 自动 JSON.stringify；可选 key 传入。
 */
export async function sendJSON(
  producer: Producer,
  topic: string,
  value: unknown,
  key?: string
): Promise<void> {
  await producer.send({
    topic,
    messages: [
      {
        key: key !== undefined ? key : undefined,
        value: JSON.stringify(value),
      },
    ],
  });
}

/**
 * 创建一个消费者，绑定到指定 topic 与 groupId。
 * 返回未连接的 consumer；调用方通过 runConsumer(consumer, onMessage) 启动，
 * eachMessage 回调将直接拿到 parsed JSON。
 */
export function createConsumer(groupId: string, topic: string): Consumer {
  const consumer = getKafka().consumer({ groupId });
  // 把 topic 挂在 consumer 上，供 runConsumer 使用。
  (consumer as unknown as { _topic?: string })._topic = topic;
  return consumer;
}

/**
 * 幂等创建 3 个 topic：
 * - agent-tasks     (3 partitions)
 * - agent-results   (1 partition)
 * - agent-control   (1 partition)
 *
 * 已存在则跳过（catch already exists）。
 */
export async function kafkaCreateTopics(): Promise<void> {
  const admin = getKafka().admin();
  await admin.connect();
  try {
    const topics = [
      { topic: TASKS_TOPIC, numPartitions: 3, replicationFactor: 1 },
      { topic: RESULTS_TOPIC, numPartitions: 1, replicationFactor: 1 },
      { topic: CONTROL_TOPIC, numPartitions: 1, replicationFactor: 1 },
    ];
    try {
      await admin.createTopics({
        topics,
        waitForLeaders: true,
      });
      console.log('[createTopics] created:', topics.map((t) => t.topic).join(', '));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists/i.test(msg)) {
        console.log('[createTopics] topics already exist, skipped');
      } else {
        throw err;
      }
    }
  } finally {
    await admin.disconnect();
  }
}

/**
 * 启动由 createConsumer 创建的消费者：
 * connect → subscribe → run，eachMessage 回调拿到 parsed JSON（解析失败时回退为原始字符串）。
 */
export async function runConsumer(
  consumer: Consumer,
  onMessage: (msg: unknown, payload: EachMessagePayload) => Promise<void>,
  fromBeginning = true
): Promise<void> {
  const topic = (consumer as unknown as { _topic?: string })._topic;
  if (!topic) {
    throw new Error('runConsumer: consumer 必须由 createConsumer 创建');
  }
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning });
  await consumer.run({
    eachMessage: async (payload: EachMessagePayload) => {
      const raw = payload.message.value;
      const text = raw ? raw.toString() : '';
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      await onMessage(parsed, payload);
    },
  });
}
