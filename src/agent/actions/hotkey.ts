import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Action } from '../../shared/types.js';

type HotkeyAction = Extract<Action, { type: 'hotkey' }>;
const execFileAsync = promisify(execFile);

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Sends keystrokes through PowerShell + System.Windows.Forms.SendKeys.
 * This keeps the agent free of native dependencies at the cost of requiring
 * the target window to be focused (optionally selected by title substring).
 */
export class HotkeyHandler {
  async execute(action: HotkeyAction): Promise<void> {
    const focus = action.windowTitle
      ? `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TwitchPcWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$target = Get-Process | Where-Object { $_.MainWindowTitle -like '*${escapePowerShell(action.windowTitle)}*' } | Select-Object -First 1
if ($target) {
  [TwitchPcWindow]::ShowWindow($target.MainWindowHandle, 9) | Out-Null
  [TwitchPcWindow]::SetForegroundWindow($target.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 250
}
`
      : '';

    const script = `
Add-Type -AssemblyName System.Windows.Forms
${focus}[System.Windows.Forms.SendKeys]::SendWait('${escapePowerShell(action.keys)}')
`;

    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true
    });
  }
}
