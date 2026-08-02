import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { TaskMessage, TaskResult } from '../types';
import { loadSettings } from '../config/settings';

/**
 * 取字符串末尾 n 个字符；空串或不足 n 时原样返回。
 */
function tail(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(s.length - n);
}

/**
 * 调用 trae-cli 执行单个 TaskMessage，并将结构化 TaskResult 写入 task.expected_output.result_file。
 *
 * 降级说明：当前仅实现 TRAE_ENGINE === 'cli' 分支（spawn 真实 trae-cli 进程）；
 * 'api' 等其他引擎暂未实现，调用时会直接抛错。环境若未安装 trae-cli，
 * spawn 会触发 'error' 事件，status 落为 'failed'，error 字段记录原因。
 */
export async function triggerTrae(task: TaskMessage): Promise<TaskResult> {
  const settings = loadSettings();

  // 2. inbox 下的 markdown 任务文件路径
  const mdPath = path.join(settings.RUNTIME_DIR, 'inbox', `${task.task_id}.md`);

  // 3. 结果文件路径解析（相对路径基于 process.cwd()）并预创建目录
  let resultFile = task.expected_output.result_file;
  if (!path.isAbsolute(resultFile)) {
    resultFile = path.resolve(process.cwd(), resultFile);
  }
  await fs.promises.mkdir(path.dirname(resultFile), { recursive: true });

  // 4. 超时（默认 1800s）
  const timeoutMs = (task.timeout_sec ?? 1800) * 1000;

  // 5. 引擎校验：当前仅支持 cli
  if (settings.TRAE_ENGINE !== 'cli') {
    throw new Error(`TRAE_ENGINE=${settings.TRAE_ENGINE} 暂未实现，当前仅支持 cli`);
  }

  // 6. 构造命令参数
  const args: string[] = ['run', '--file', mdPath, '--output', resultFile];
  if (task.expected_output.patch_required) {
    args.push('--must-patch');
  }
  // max_steps 控制执行步数上限（与 timeout_sec 共同约束执行边界）
  if (typeof task.max_steps === 'number' && task.max_steps > 0) {
    args.push('--max-steps', String(task.max_steps));
  }

  // 7. 计时起点
  const t0 = Date.now();

  // 8. spawn 启动 trae-cli，收集输出，等待 exit/close 或超时
  const child = spawn(settings.TRAE_CLI_PATH, args, {
    cwd: task.workspace || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });

  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;

  const runResult = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      let exitCode: number | null = null;
      let resolved = false;

      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        // kill 后 'exit'/'close' 仍会触发，由其 resolve；兜底再 resolve 一次
      }, timeoutMs);

      const done = () => {
        if (resolved) return;
        resolved = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve({ code: exitCode, stdout, stderr, timedOut });
      };

      child.on('exit', (code) => {
        exitCode = code;
      });
      child.on('close', () => {
        done();
      });
      child.on('error', (err) => {
        stderr += `\nspawn error: ${err.message}`;
        exitCode = null;
        done();
      });
    },
  );

  const code = runResult.code;
  const outStr = runResult.stdout;
  const errStr = runResult.stderr;

  // 9. 耗时
  const duration_sec = Math.round((Date.now() - t0) / 1000);

  // 10. 尝试读取 trae-cli --output 文件（被 trae-cli 写入的原始产物）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let traeOut: any = {};
  try {
    const raw = await fs.promises.readFile(resultFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      traeOut = parsed;
    } else {
      traeOut = {};
    }
  } catch {
    traeOut = {};
  }

  // 11. 计算 patch（仅当 patch_required）
  let patch = '';
  if (task.expected_output.patch_required) {
    try {
      patch = execSync('git diff', { cwd: task.workspace }).toString();
    } catch {
      patch = '';
    }
  }

  // 11. 计算 summary
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traeSummary: any = (traeOut as any)?.summary;
  const summary: string =
    typeof traeSummary === 'string' && traeSummary ? traeSummary : tail(outStr, 500);

  // 11. 计算 artifacts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traeArtifacts: any = (traeOut as any)?.artifacts;
  const artifacts: string[] = Array.isArray(traeArtifacts) ? traeArtifacts : [];

  // 11. 计算 error
  const error: string = timedOut
    ? 'trae-cli timeout'
    : code !== 0
      ? tail(errStr, 1000) || `trae-cli exited ${code}`
      : '';

  // 11. 计算 status
  const status: TaskResult['status'] = !timedOut && code === 0 ? 'success' : 'failed';

  // 11. 计算 metrics（安全取值）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traeMetrics: any = (traeOut as any)?.metrics;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traeToken: any = traeMetrics?.token_usage;
  const metrics: TaskResult['metrics'] = {
    duration_sec,
    token_usage: {
      input: Number(traeToken?.input ?? 0),
      output: Number(traeToken?.output ?? 0),
    },
  };

  // 11. 组装 TaskResult
  const result: TaskResult = {
    schema_version: '1.0',
    task_id: task.task_id,
    worker_id: task.worker_id,
    status,
    summary,
    artifacts,
    patch,
    metrics,
    error,
    completed_at: new Date().toISOString(),
  };

  // 12. 覆盖写入 resultFile
  await fs.promises.writeFile(resultFile, JSON.stringify(result, null, 2), 'utf8');

  // 13. 返回
  return result;
}

// CLI 入口：node triggerTrae.js <inbox-task.json>
if (require.main === module) {
  const taskJsonPath = process.argv[2];
  if (!taskJsonPath) {
    console.error('用法: node triggerTrae.js <inbox-task.json>');
    process.exit(1);
  }
  (async () => {
    const raw = await fs.promises.readFile(taskJsonPath, 'utf8');
    const task: TaskMessage = JSON.parse(raw);
    const result = await triggerTrae(task);
    console.log(result.status);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
