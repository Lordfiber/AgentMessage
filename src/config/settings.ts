import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

/**
 * 全局配置：对应 config/settings.env 的字段。
 * 路径类字段（RUNTIME_DIR/DLQ_DIR/PROCESSED_FILE/WORKER_LOCK）
 * 已解析为绝对路径（基于 process.cwd()）。
 */
export interface Settings {
  KAFKA_BOOTSTRAP: string;
  WORKER_ID: string;
  WORKER_ROLE: string;
  POLL_MIN: number;
  TRAE_ENGINE: 'cli' | 'api' | string;
  TRAE_CLI_PATH: string;
  RUNTIME_DIR: string;
  DLQ_DIR: string;
  PROCESSED_FILE: string;
  WORKER_LOCK: string;
  AGENT_HOOK_URL: string; // Agent 完成 Hook 黑盒后端地址，空则 no-op
}

/**
 * 将相对路径解析为绝对路径（基于 process.cwd()）。
 * 已是绝对路径则原样返回。
 */
function toAbsolute(p: string): string {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * 加载 config/settings.env，返回合并默认值后的 Settings。
 * 找不到 settings.env 时仅使用默认值。
 */
export function loadSettings(): Settings {
  const envPath = path.resolve(process.cwd(), 'config', 'settings.env');
  // dotenv 不会覆盖已存在的 process.env，这里把 .env 内容读进 process.env
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  const pollRaw = process.env.POLL_MIN ?? '2';
  const pollMin = Number.isNaN(Number(pollRaw)) ? 2 : Number(pollRaw);

  const runtimeDir = toAbsolute(process.env.RUNTIME_DIR ?? './runtime');
  const dlqDir = toAbsolute(process.env.DLQ_DIR ?? './runtime/state/_dlq');
  const processedFile = toAbsolute(process.env.PROCESSED_FILE ?? './runtime/state/processed.jsonl');
  const workerLock = toAbsolute(process.env.WORKER_LOCK ?? './runtime/state/worker.lock');

  return {
    KAFKA_BOOTSTRAP: process.env.KAFKA_BOOTSTRAP ?? '192.168.1.10:9092',
    WORKER_ID: process.env.WORKER_ID ?? '',
    WORKER_ROLE: process.env.WORKER_ROLE ?? '',
    POLL_MIN: pollMin,
    TRAE_ENGINE: process.env.TRAE_ENGINE ?? 'cli',
    TRAE_CLI_PATH: process.env.TRAE_CLI_PATH ?? 'trae-cli',
    RUNTIME_DIR: runtimeDir,
    DLQ_DIR: dlqDir,
    PROCESSED_FILE: processedFile,
    WORKER_LOCK: workerLock,
    AGENT_HOOK_URL: process.env.AGENT_HOOK_URL ?? '',
  };
}
