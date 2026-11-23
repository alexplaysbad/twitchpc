import { spawn } from 'node:child_process';
import type { Action } from '../../shared/types.js';

type CmdAction = Extract<Action, { type: 'cmd' }>;

const MAX_OUTPUT = 2000;

/**
 * Runs an exact, pre-approved command line through Windows cmd.exe.
 *
 * Nothing from the cloud is executed unless it matches CMD_ALLOWLIST on the
 * agent. Templates may fill in placeholders, but the final rendered string is
 * what gets checked, so a viewer cannot smuggle extra commands through a
 * variable.
 */
export class CmdHandler {
  constructor(
    private readonly allowlist: string[],
    private readonly timeoutMs: number
  ) {}

  async execute(action: CmdAction): Promise<void> {
    const command = action.command.trim();
    if (!command) throw new Error('cmd command is empty');

    const allowed = this.allowlist.some((entry) => entry.toLowerCase() === command.toLowerCase());
    if (!allowed) {
      throw new Error(`Command "${command}" is not in CMD_ALLOWLIST`);
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
        cwd: action.cwd || undefined,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const append = (chunk: Buffer | string): void => {
        output = (output + chunk.toString()).slice(-MAX_OUTPUT);
      };

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (code === 0) {
          finish();
          return;
        }
        const detail = output.trim();
        finish(new Error(`cmd.exe exited with code ${code}${detail ? `: ${detail}` : ''}`));
      });

      timer = setTimeout(() => {
        child.kill();
        finish(new Error(`cmd.exe command timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref();
    });
  }
}
