import { BaseTool } from '../base-tool.js';
import { bool, int, z } from '../params.js';
import type {
  PreviewInfo,
  PreviewThunk,
  ToolContext,
  ToolDef,
  ToolOutput,
} from '../types.js';
import { ChildProcessJob, type ChildProcessExit } from './child-process-job.js';
import { classifyExit } from './exit-code-policy.js';
import { appLog } from '../../observability/logging/app-log.js';

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;

const shellSchema = z.object({
  command: z.string().trim().min(1).describe('Shell command to execute.'),
  cwd: z.string().min(1).optional().describe(
    'Working directory for this call. Defaults to this agent workspace and does not persist.',
  ),
  timeout: int(z.gte(MIN_TIMEOUT_MS), z.lte(MAX_TIMEOUT_MS))
    .default(DEFAULT_TIMEOUT_MS)
    .describe('Foreground wait in milliseconds, from 1000 to 600000.'),
  description: z.string().trim().min(1).optional().describe(
    'Brief human-readable command description for approval and activity display.',
  ),
  run_in_background: bool().default(false).describe('Start directly as a background task.'),
});

type ShellParams = z.infer<typeof shellSchema>;
type ShellData =
  | Readonly<{ exitCode: number; durationMs: number; note?: string }>
  | Readonly<{ taskId: string; outFile: string }>;

const DESCRIPTION = `Execute a shell command with bash (or PowerShell on Windows). Each call is independent; cwd defaults to this agent workspace and never persists.

Prefer dedicated read/write/edit/glob/grep/ls tools over cat, head, tail, sed, awk, echo, grep, or find. Prefer absolute paths. Foreground waiting is limited to 10 minutes; reaching timeout moves the still-running process into the background instead of killing it. Set run_in_background=true to do that immediately. Background output is read with read(file_path, offset). For strict stdout/stderr interleaving, write 2>&1 in the command yourself.`;

type RaceWinner =
  | { kind: 'exit'; outcome: ChildProcessExit }
  | { kind: 'timeout' }
  | { kind: 'promote' }
  | { kind: 'abort'; reason: unknown };

export class ShellTool extends BaseTool<ShellParams, ShellData> {
  readonly def: ToolDef<ShellParams> = {
    name: 'shell',
    description: DESCRIPTION,
    schema: shellSchema,
    scope: 'shared',
    effects: ['exec'],
    policy: {
      pathParams: { cwd: 'workspace-default' },
      backgroundable: true,
      streamingOutput: true,
    },
  };

  async prepare(params: ShellParams): Promise<PreviewThunk> {
    return async (): Promise<PreviewInfo> => ({
      type: 'command',
      title: params.description ?? 'Run shell command',
      content: params.command,
    });
  }

  async execute(params: ShellParams, ctx: ToolContext): Promise<ToolOutput<ShellData>> {
    if (!ctx.spool) return this.error('shell 缺少 OutputSpool，这是内部错误。');
    if (!ctx.background) return this.error('shell 缺少后台任务宿主，这是内部错误。');
    if (ctx.signal.aborted) return this.error(`Command aborted: ${abortReason(ctx.signal.reason)}`);

    const cwd = params.cwd ?? ctx.workspace.dir;
    const timeoutMs = clampTimeout(params.timeout);
    let job: ChildProcessJob;
    try {
      job = new ChildProcessJob({
        command: params.command,
        cwd,
        tempDir: ctx.workspace.tempDir,
        spool: ctx.spool,
        onWarning: (message, error) => appLog.warn({
          event: 'tool.shell.output_capture.degraded',
          message: 'Shell output capture degraded',
          context: {
            scope: 'tool.shell',
            agentId: ctx.agentId,
            callId: ctx.callId,
            warningReason: message.slice(0, 240),
          },
          error,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`Command failed to start: ${message}`);
    }

    if (params.run_in_background) {
      return this.adopt(job, 'declared', ctx);
    }

    const registration = ctx.background.offer(job);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = (): void => undefined;
    const timeoutPromise = new Promise<RaceWinner>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    });
    const abortPromise = new Promise<RaceWinner>((resolve) => {
      const onAbort = (): void => resolve({ kind: 'abort', reason: ctx.signal.reason });
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => ctx.signal.removeEventListener('abort', onAbort);
    });

    const winner = await Promise.race<RaceWinner>([
      job.exited().then((outcome) => ({ kind: 'exit', outcome })),
      timeoutPromise,
      registration.promoted.then(() => ({ kind: 'promote' })),
      abortPromise,
    ]);
    if (timeout) clearTimeout(timeout);
    removeAbort();

    if (winner.kind === 'timeout' || winner.kind === 'promote') {
      return this.adopt(job, winner.kind === 'timeout' ? 'timeout' : 'user', ctx);
    }

    registration.withdraw();
    if (winner.kind === 'abort') {
      await job.kill();
      await job.removeOutputFile();
      return this.error(`Command aborted: ${abortReason(winner.reason)}`);
    }

    const output = ctx.spool.textForModel();
    await job.removeOutputFile();
    const exitCode = winner.outcome.exitCode;
    if (exitCode === undefined) {
      return this.error(output || winner.outcome.tail || 'Command failed before producing an exit code.');
    }
    const classification = classifyExit(params.command, exitCode);
    const text = classification.ok
      ? joinOutput(classification.note, output)
      : joinOutput(`Exit code ${exitCode}`, output);
    const data = {
      exitCode,
      durationMs: winner.outcome.durationMs,
      ...(classification.note ? { note: classification.note } : {}),
    };
    return classification.ok ? this.success(text, data) : this.error(text, data);
  }

  private async adopt(
    job: ChildProcessJob,
    reason: 'declared' | 'timeout' | 'user',
    ctx: ToolContext,
  ): Promise<ToolOutput<ShellData>> {
    try {
      const handle = ctx.background!.adopt(job, reason);
      job.detachSpool();
      const lead = reason === 'declared'
        ? '在后台运行。'
        : reason === 'timeout'
          ? '已转入后台（前台等待到时）。'
          : '已转入后台（用户要求）。';
      return this.success(
        `${lead}任务 ${handle.id}，输出 ${handle.outFile}。完成时你会收到通知。`,
        { taskId: handle.id, outFile: handle.outFile },
      );
    } catch (error) {
      await job.kill();
      const message = error instanceof Error ? error.message : String(error);
      return this.error(`后台任务接管失败，已终止进程：${message}`);
    }
  }
}

export function clampTimeout(value: number): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, value));
}

function joinOutput(note: string | undefined, output: string): string {
  if (!note) return output;
  return output ? `${note}\n${output}` : note;
}

function abortReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : reason == null ? 'operation cancelled' : String(reason);
}
