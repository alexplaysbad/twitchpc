import { describe, expect, it } from 'vitest';
import { CmdHandler } from '../src/agent/actions/cmd.js';

const baseAction = {
  id: 'a1',
  type: 'cmd' as const,
  target: 'agent' as const,
  command: 'echo hello'
};

describe('CmdHandler', () => {
  it('rejects commands not in the allowlist', async () => {
    const handler = new CmdHandler(['shutdown /s /t 0'], 1000);
    await expect(handler.execute(baseAction)).rejects.toThrow(/not in CMD_ALLOWLIST/);
  });

  it('rejects empty commands', async () => {
    const handler = new CmdHandler(['echo hello'], 1000);
    await expect(handler.execute({ ...baseAction, command: '   ' })).rejects.toThrow(/empty/);
  });

  it.runIf(process.platform === 'win32')('runs an exact allowlisted command', async () => {
    const handler = new CmdHandler(['echo hello'], 5000);
    await expect(handler.execute(baseAction)).resolves.toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('matches allowlist case-insensitively', async () => {
    const handler = new CmdHandler(['ECHO HELLO'], 5000);
    await expect(handler.execute(baseAction)).resolves.toBeUndefined();
  });
});
