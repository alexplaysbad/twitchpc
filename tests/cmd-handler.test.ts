import { describe, expect, it } from 'vitest';
import { CmdHandler } from '../src/agent/actions/cmd.js';

const baseAction = {
  id: 'a1',
  type: 'cmd' as const,
  target: 'agent' as const,
  command: 'echo hello'
};

describe('CmdHandler', () => {
  it('rejects empty commands', async () => {
    const handler = new CmdHandler(1000);
    await expect(handler.execute({ ...baseAction, command: '   ' })).rejects.toThrow(/empty/);
  });

  it.runIf(process.platform === 'win32')('runs a command', async () => {
    const handler = new CmdHandler(5000);
    await expect(handler.execute(baseAction)).resolves.toBeUndefined();
  });
});
