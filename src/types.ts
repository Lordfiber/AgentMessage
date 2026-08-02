// 消息契约类型定义（schema_version = '1.0'）
// 严格按 spec 附录定义，必填字段直接给出，可选字段加 '?'

export type TaskType = 'pm' | 'dev' | 'review' | 'qa' | 'deploy';
export type TaskStatus = 'success' | 'failed' | 'partial';
export type ControlCmd = 'stop' | 'pause' | 'resume';

export interface Constraints {
  language?: string;
  style?: string;
  forbidden?: string[];
}

export interface Directive {
  objective: string; // 必填
  background?: string;
  context_refs?: string[];
  instructions: string[]; // 必填
  constraints?: Constraints;
  acceptance_criteria: string[]; // 必填
}

export interface ResultSchema {
  status: string;
  summary: string;
  artifacts: string[];
  patch: string;
  metrics: { duration_sec: number; token_usage: { input: number; output: number } };
  error: string;
}

export interface ExpectedOutput {
  deliverables: string[]; // 必填
  result_file: string; // 必填
  result_schema: ResultSchema; // 必填
  patch_required: boolean; // 必填
}

export interface TaskMessage {
  schema_version: string; // '1.0'
  task_id: string;
  parent_task_id?: string;
  worker_id: string;
  worker_role?: string;
  type: TaskType;
  priority?: number;
  created_at: string;
  timeout_sec?: number;
  max_steps?: number;
  directive: Directive;
  workspace?: string;
  workdir?: string;
  expected_output: ExpectedOutput;
}

export interface TaskResult {
  schema_version: string;
  task_id: string;
  worker_id: string;
  status: TaskStatus;
  summary: string;
  artifacts: string[];
  patch: string;
  metrics: { duration_sec: number; token_usage: { input: number; output: number } };
  error: string;
  completed_at: string;
}

export interface ControlMessage {
  schema_version: string;
  cmd: ControlCmd;
  worker_id: string; // '*' 表示全体
  issued_at: string;
}
