import { spawn } from 'node:child_process';
import type { Action } from '../../shared/types.js';

type ExecAction = Extract<Action, { type: 'exec' }>;

export class ExecHandler {
  async execute(action: ExecAction): Promise<void> {
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
