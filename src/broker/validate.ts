import * as fs from 'fs';
import * as path from 'path';
import {
  TaskMessage,
  TaskResult,
  ControlMessage,
  TaskStatus,
  ControlCmd,
} from '../types';

export const SCHEMA_VERSION = '1.0';

/**
 * 校验失败时抛出，message 含出错字段名。
 */
export class ValidationError extends Error {
  constructor(field: string, reason: string) {
    super(`ValidationError [${field}]: ${reason}`);
    this.name = 'ValidationError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNonEmptyString(v: unknown): v is string {
  return isString(v) && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');
}

/**
 * 断言 msg 是对象且 schema_version === '1.0'，返回 Record 视图供后续字段访问。
 */
function asVersionedObject(msg: unknown, kind: string): Record<string, unknown> {
  if (!isObject(msg)) {
    throw new ValidationError(kind, 'must be an object');
  }
  if (msg.schema_version !== SCHEMA_VERSION) {
    throw new ValidationError(
      `${kind}.schema_version`,
      `expected "${SCHEMA_VERSION}", got ${JSON.stringify(msg.schema_version)}`
    );
  }
  return msg;
}

/**
 * 校验 TaskMessage（schema_version='1.0' + 必填字段）。
 * 校验通过返回强类型 TaskMessage；否则抛 ValidationError。
 */
export function validateTaskMessage(msg: unknown): TaskMessage {
  const m = asVersionedObject(msg, 'TaskMessage');

  if (!isNonEmptyString(m.task_id)) {
    throw new ValidationError('task_id', 'required non-empty string');
  }
  if (!isNonEmptyString(m.worker_id)) {
    throw new ValidationError('worker_id', 'required non-empty string');
  }
  if (!isString(m.type)) {
    throw new ValidationError('type', 'required string');
  }
  const validTypes: TaskMessage['type'][] = ['pm', 'dev', 'review', 'qa', 'deploy'];
  if (!validTypes.includes(m.type as TaskMessage['type'])) {
    throw new ValidationError('type', `must be one of ${validTypes.join('|')}`);
  }
  if (!isNonEmptyString(m.created_at)) {
    throw new ValidationError('created_at', 'required non-empty string');
  }

  // directive
  const d = m.directive;
  if (!isObject(d)) {
    throw new ValidationError('directive', 'required object');
  }
  if (!isNonEmptyString(d.objective)) {
    throw new ValidationError('directive.objective', 'required non-empty string');
  }
  if (!isNonEmptyStringArray(d.instructions)) {
    throw new ValidationError('directive.instructions', 'required non-empty string[]');
  }
  if (!isNonEmptyStringArray(d.acceptance_criteria)) {
    throw new ValidationError(
      'directive.acceptance_criteria',
      'required non-empty string[]'
    );
  }

  // expected_output
  const eo = m.expected_output;
  if (!isObject(eo)) {
    throw new ValidationError('expected_output', 'required object');
  }
  if (!isNonEmptyStringArray(eo.deliverables)) {
    throw new ValidationError('expected_output.deliverables', 'required non-empty string[]');
  }
  if (!isNonEmptyString(eo.result_file)) {
    throw new ValidationError('expected_output.result_file', 'required non-empty string');
  }
  if (!isObject(eo.result_schema)) {
    throw new ValidationError('expected_output.result_schema', 'required object');
  }
  if (typeof eo.patch_required !== 'boolean') {
    throw new ValidationError('expected_output.patch_required', 'required boolean');
  }

  return m as unknown as TaskMessage;
}

/**
 * 校验 TaskResult。status 必须 ∈ success|failed|partial。
 */
export function validateTaskResult(msg: unknown): TaskResult {
  const m = asVersionedObject(msg, 'TaskResult');

  if (!isNonEmptyString(m.task_id)) {
    throw new ValidationError('task_id', 'required non-empty string');
  }
  if (!isNonEmptyString(m.worker_id)) {
    throw new ValidationError('worker_id', 'required non-empty string');
  }
  const validStatus: TaskStatus[] = ['success', 'failed', 'partial'];
  if (!isString(m.status) || !validStatus.includes(m.status as TaskStatus)) {
    throw new ValidationError('status', `must be one of ${validStatus.join('|')}`);
  }
  if (!isString(m.summary)) {
    throw new ValidationError('summary', 'required string');
  }
  if (!isStringArray(m.artifacts)) {
    throw new ValidationError('artifacts', 'required string[]');
  }
  if (!isString(m.patch)) {
    throw new ValidationError('patch', 'required string');
  }
  const metrics = m.metrics;
  if (!isObject(metrics)) {
    throw new ValidationError('metrics', 'required object');
  }
  if (typeof metrics.duration_sec !== 'number') {
    throw new ValidationError('metrics.duration_sec', 'required number');
  }
  const tu = metrics.token_usage;
  if (!isObject(tu)) {
    throw new ValidationError('metrics.token_usage', 'required object');
  }
  if (typeof tu.input !== 'number') {
    throw new ValidationError('metrics.token_usage.input', 'required number');
  }
  if (typeof tu.output !== 'number') {
    throw new ValidationError('metrics.token_usage.output', 'required number');
  }
  if (!isString(m.error)) {
    throw new ValidationError('error', 'required string');
  }
  if (!isNonEmptyString(m.completed_at)) {
    throw new ValidationError('completed_at', 'required non-empty string');
  }

  return m as unknown as TaskResult;
}

/**
 * 校验 ControlMessage。cmd 必须 ∈ stop|pause|resume。
 */
export function validateControlMessage(msg: unknown): ControlMessage {
  const m = asVersionedObject(msg, 'ControlMessage');

  const validCmd: ControlCmd[] = ['stop', 'pause', 'resume'];
  if (!isString(m.cmd) || !validCmd.includes(m.cmd as ControlCmd)) {
    throw new ValidationError('cmd', `must be one of ${validCmd.join('|')}`);
  }
  if (!isNonEmptyString(m.worker_id)) {
    throw new ValidationError('worker_id', 'required non-empty string (use "*" for all)');
  }
  if (!isNonEmptyString(m.issued_at)) {
    throw new ValidationError('issued_at', 'required non-empty string');
  }

  return m as unknown as ControlMessage;
}

/**
 * 将校验失败的原始消息写入死信队列（DLQ）。
 * 文件名：${dlqDir}/${topic}-${Date.now()}.json
 * 内容：{ topic, reason, ts, payload }
 * dlqDir 不存在时会自动创建（recursive）。
 */
export async function writeToDLQ(
  topic: string,
  payload: unknown,
  reason: string,
  dlqDir: string
): Promise<void> {
  await fs.promises.mkdir(dlqDir, { recursive: true });
  const record = {
    topic,
    reason,
    ts: new Date().toISOString(),
    payload,
  };
  const file = path.join(dlqDir, `${topic}-${Date.now()}.json`);
  await fs.promises.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
}
