import { spawn } from 'node:child_process';
import type { Action } from '../../shared/types.js';

type ExecAction = Extract<Action, { type: 'exec' }>;

export class ExecHandler {
  constructor(private readonly allowlist: string[]) {}

  async execute(action: ExecAction): Promise<void> {
    const allowed = this.allowlist.some(
      (entry) => entry.toLowerCase() === action.command.toLowerCase()
    );
    if (!allowed) {
      throw new Error(`Command "${action.command}" is not in EXEC_ALLOWLIST`);
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(action.command, action.args, {
        cwd: action.cwd,
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
  }
}
