// Orchestrator 侧输入清理层：统一调 markitdown 把任意格式输入转为 Markdown，
// 再把清洗后的 .md 喂给 LLM。
// - 只在 Orchestrator/TRAE-A 使用（worker 不处理杂格式输入）。
// - 不关心 markitdown 安装（用户保证 PATH 里有）。
// - markitdown 失败/不可用时"原样回退"，保证流程不中断。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface NormalizeResult {
  ok: boolean;
  /** 清洗后 Markdown 文件的绝对路径 */
  outputMd: string;
  /** 是否走了 markitdown 转换（false = 回退到原始拷贝/写入） */
  converted: boolean;
  error?: string;
}

const TEMP_CLEAN_DIR = path.join(process.cwd(), 'runtime', 'input-clean');

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * 调用 markitdown。优先走 `markitdown <input> -o <output>`，
 * 如果 markitdown 版本不支持 -o 则回退到 stdout 重定向。
 * 任何 markitdown 相关异常全部 reject，由上层走回退。
 */
async function runMarkitdown(input: string, output: string, markitdownBin = 'markitdown'): Promise<void> {
  // 先试 -o 参数
  try {
    await execFileAsync(markitdownBin, [input, '-o', output], {
      timeout: 120_000,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    if (fs.existsSync(output) && (await fs.promises.stat(output)).size > 0) return;
  } catch {
    /* 走 stdout 回退 */
  }
  // 回退：stdout 输出写文件
  const { stdout } = await execFileAsync(markitdownBin, [input], {
    timeout: 120_000,
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
  await fs.promises.writeFile(output, stdout, 'utf8');
}

/**
 * 把一个任意格式文件（doc/docx/pdf/txt/...）清洗为 Markdown。
 * 输出落到 `runtime/input-clean/<basename>.md`。
 */
export async function normalizePath(inputFile: string, opts: { markitdownBin?: string } = {}): Promise<NormalizeResult> {
  const abs = path.resolve(inputFile);
  if (!fs.existsSync(abs)) {
    return { ok: false, outputMd: abs, converted: false, error: `input file not found: ${abs}` };
  }

  await ensureDir(TEMP_CLEAN_DIR);
  const base = path.basename(abs);
  const outMd = path.join(TEMP_CLEAN_DIR, `${base}.md`);

  try {
    await runMarkitdown(abs, outMd, opts.markitdownBin);
    return { ok: true, outputMd: outMd, converted: true };
  } catch (err) {
    // markitdown 不可用 / 失败 → 回退：原样拷贝一份改后缀 .md，保证 Orchestrator 总能拿到 .md
    try {
      const raw = await fs.promises.readFile(abs, null);
      // 二进制/未知格式尝试 utf8 读，乱码也比流程中断好
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      await fs.promises.writeFile(outMd, text, 'utf8');
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, outputMd: outMd, converted: false, error: `markitdown failed: ${msg}` };
    } catch (fallback) {
      const msg = fallback instanceof Error ? fallback.message : String(fallback);
      return { ok: false, outputMd: abs, converted: false, error: `fallback also failed: ${msg}` };
    }
  }
}

/**
 * 把一段原始文本（手动输入、企业微信消息、剪贴板内容等）交给 markitdown 清洗。
 * 做法：先写临时文件（扩展名由 extHint 猜，markitdown 会按扩展名选择解析器），
 * 再调 markitdown 转 .md。markitdown 不可用时直接把原文写成 .md 返回。
 */
export async function normalizeText(
  raw: string,
  extHint = 'txt',
  opts: { markitdownBin?: string } = {}
): Promise<NormalizeResult> {
  await ensureDir(TEMP_CLEAN_DIR);
  const stub = `raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extHint.replace(/^\./, '')}`;
  const tmp = path.join(os.tmpdir(), stub);
  await fs.promises.writeFile(tmp, raw, 'utf8');
  const outMd = path.join(TEMP_CLEAN_DIR, `${stub}.md`);

  try {
    await runMarkitdown(tmp, outMd, opts.markitdownBin);
    return { ok: true, outputMd: outMd, converted: true };
  } catch (err) {
    try {
      await fs.promises.writeFile(outMd, raw, 'utf8');
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, outputMd: outMd, converted: false, error: `markitdown failed: ${msg}` };
    } finally {
      fs.promises.unlink(tmp).catch(() => undefined);
    }
  }
}

/**
 * CLI 便捷入口：
 *   npx tsx src/orchestrator/normalizeInput.ts nio.pdf      # 输出 runtime/input-clean/nio.pdf.md
 *   npx tsx src/orchestrator/normalizeInput.ts --text '一段消息' --ext docx
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(
      'Usage:\n' +
        '  npx tsx src/orchestrator/normalizeInput.ts <file>\n' +
        '  npx tsx src/orchestrator/normalizeInput.ts --text <text> --ext <ext>\n'
    );
    process.exit(1);
  }

  if (args[0] === '--text') {
    const text = args[1] ?? '';
    const extIdx = args.indexOf('--ext');
    const ext = extIdx >= 0 ? args[extIdx + 1] ?? 'txt' : 'txt';
    const r = await normalizeText(text, ext);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }

  const r = await normalizePath(args[0]);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`normalizeInput failed: ${msg}\n`);
    process.exit(1);
  });
}
