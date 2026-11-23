import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AgentConfig } from './config.js';

interface ReleaseManifest {
  version: string;
  sha256: string;
  file: string;
}

export function httpOrigin(cloudUrl: string): string {
  const url = new URL(cloudUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function sha256(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function quote(path: string): string {
  return `"${path.replace(/"/g, '""')}"`;
}

export async function checkForUpdate(config: AgentConfig, log: (message: string) => void): Promise<boolean> {
  if (!config.AGENT_AUTO_UPDATE) return false;

  const currentExe = process.execPath;
  if (!currentExe.toLowerCase().endsWith('.exe') || basename(currentExe) !== 'twitchpc-agent.exe') {
    return false;
  }

  const origin = httpOrigin(config.CLOUD_URL);
  try {
    const response = await fetch(`${origin}/api/agent/version`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return false;
    const remote = await response.json() as ReleaseManifest;
    if (!remote.version || !remote.sha256 || !remote.file) return false;

    const currentHash = sha256(readFileSync(currentExe));
    if (currentHash === remote.sha256) return false;

    log(`Agent update available: ${remote.version}`);
    const download = await fetch(`${origin}/download/${encodeURIComponent(remote.file)}`, {
      signal: AbortSignal.timeout(60_000)
    });
    if (!download.ok) throw new Error(`download failed with ${download.status}`);

    const bytes = new Uint8Array(await download.arrayBuffer());
    const downloadedHash = sha256(bytes);
    if (downloadedHash !== remote.sha256) {
      throw new Error(`sha256 mismatch (expected ${remote.sha256}, got ${downloadedHash})`);
    }

    const dir = dirname(currentExe);
    const nextExe = join(dir, 'twitchpc-agent.next.exe');
    const nextVersion = join(dir, 'version.next.json');
    const batch = join(dir, 'twitchpc-update.bat');
    writeFileSync(nextExe, bytes);
    writeFileSync(nextVersion, `${JSON.stringify(remote, null, 2)}\n`);

    const exeQ = quote(currentExe);
    const nextQ = quote(nextExe);
    const versionQ = quote(join(dir, 'version.json'));
    const nextVersionQ = quote(nextVersion);
    const restartCommand = config.AGENT_SUPERVISED
      ? 'rem Tray supervisor restarts the agent'
      : `start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "& '${currentExe.replace(/'/g, "''")}'"`;
    writeFileSync(batch, [
      '@echo off',
      ':wait',
      `move /y ${nextQ} ${exeQ} >nul 2>&1`,
      'if errorlevel 1 (timeout /t 1 /nobreak >nul & goto wait)',
      `move /y ${nextVersionQ} ${versionQ} >nul 2>&1`,
      restartCommand,
      'del "%~f0"',
      ''
    ].join('\r\n'));

    const updater = spawn('cmd.exe', ['/c', batch], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    updater.unref();
    log('Downloaded and verified update; restarting');
    return true;
  } catch (error) {
    log(`Update check skipped: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function localUpdateInfo(): string {
  if (!process.execPath.toLowerCase().endsWith('twitchpc-agent.exe')) return 'source';
  const file = join(dirname(process.execPath), 'version.json');
  if (!existsSync(file)) return 'unknown';
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as ReleaseManifest;
    return manifest.version;
  } catch {
    return 'unknown';
  }
}
