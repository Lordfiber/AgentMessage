import { kafkaCreateTopics } from './kafkaHelper';

/**
 * 幂等创建 3 个 topic：
 * - agent-tasks     (3 partitions)
 * - agent-results   (1 partition)
 * - agent-control   (1 partition)
 *
 * 已存在则跳过。可直接 `npx tsx src/broker/createTopics.ts` 运行。
 */
async function main(): Promise<void> {
  await kafkaCreateTopics();
}

main().catch((err) => {
  console.error('[createTopics] failed:', err);
  process.exit(1);
});
