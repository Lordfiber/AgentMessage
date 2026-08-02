import { execSync } from 'child_process';
import { loadSettings } from '../config/settings';

/**
 * 注册单个 Windows 计划任务：先幂等注销（SilentlyContinue），再注册。
 * 触发器为每 pollMin 分钟重复执行一次；Action 执行 node <scriptArg>，工作目录 cwd。
 *
 * PowerShell 字符串使用单引号，单引号内部转义为 ''；整个命令用双引号包裹传给
 * powershell -NoProfile -Command，内部不含双引号以避免 cmd.exe 解析歧义。
 */
function registerOne(
  taskName: string,
  scriptArg: string,
  pollMin: number,
  cwd: string
): void {
  const psTaskName = taskName.replace(/'/g, "''");
  const psArg = scriptArg.replace(/'/g, "''");
  const psCwd = cwd.replace(/'/g, "''");

  const ps = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `Unregister-ScheduledTask -TaskName '${psTaskName}' -NoNewWork`,
    `$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${pollMin})`,
    `$a = New-ScheduledTaskAction -Execute 'node' -Argument '${psArg}' -WorkingDirectory '${psCwd}'`,
    `Register-ScheduledTask -TaskName '${psTaskName}' -Trigger $t -Action $a`,
  ].join('; ');

  execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'inherit' });
}

/**
 * 注册两个 Windows 计划任务：
 * - AgentMessage-WorkerPoll：每 POLL_MIN 分钟执行 dist/triggers/workerPoll.js
 * - AgentMessage-OrchCollect：每 POLL_MIN 分钟执行 dist/triggers/orchestratorCollect.js
 * 工作目录均为当前 process.cwd()。
 */
export async function registerTasks(): Promise<void> {
  const settings = loadSettings();
  const pollMin = settings.POLL_MIN;
  const cwd = process.cwd();

  registerOne(
    'AgentMessage-WorkerPoll',
    'dist/triggers/workerPoll.js',
    pollMin,
    cwd
  );
  console.log(
    `[registerTasks] 已注册 AgentMessage-WorkerPoll（每 ${pollMin} 分钟）`
  );

  registerOne(
    'AgentMessage-OrchCollect',
    'dist/triggers/orchestratorCollect.js',
    pollMin,
    cwd
  );
  console.log(
    `[registerTasks] 已注册 AgentMessage-OrchCollect（每 ${pollMin} 分钟）`
  );
}

if (require.main === module) {
  registerTasks().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
