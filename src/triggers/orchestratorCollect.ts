import { consumeResults } from '../broker/consumeResults';

/**
 * Orchestrator 结果收集入口（供 Windows 计划任务周期调用）：
 * 从 RESULTS_TOPIC 拉取结果并落盘到 results/ 目录。
 */
export async function orchestratorCollect(): Promise<void> {
  const n = await consumeResults(20, 8000);
  console.log(`[orchestratorCollect] 收集 ${n} 条结果`);
}

if (require.main === module) {
  orchestratorCollect().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
