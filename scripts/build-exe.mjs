import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = join(root, '.sea-build');
const releaseDir = join(root, 'release');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(releaseDir, { recursive: true });

console.log('Bundling agent...');
await build({
  entryPoints: [join(root, 'src/agent/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(workDir, 'agent.cjs'),
  logLevel: 'warning'
});

const seaConfig = {
  main: join(workDir, 'agent.cjs'),
  output: join(workDir, 'agent.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: true
};
const seaConfigPath = join(workDir, 'sea-config.json');
writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

console.log('Generating SEA blob...');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
  cwd: root,
  stdio: 'inherit'
});

const exePath = join(releaseDir, 'twitchpc-agent.exe');
copyFileSync(process.execPath, exePath);

console.log('Injecting blob into executable...');
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules/postject/dist/cli.js'),
    exePath,
    'NODE_SEA_BLOB',
    join(workDir, 'agent.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ],
  { cwd: root, stdio: 'inherit' }
);

console.log('Building Windows tray launcher...');
const csc = join(
  process.env.WINDIR || 'C:\\Windows',
  'Microsoft.NET',
  'Framework',
  'v4.0.30319',
  'csc.exe'
);
if (!existsSync(csc)) {
  throw new Error(`Could not find the .NET Framework C# compiler at ${csc}`);
}
const trayExe = join(releaseDir, 'TwitchPC Agent.exe');
execFileSync(
  csc,
  [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    `/out:${trayExe}`,
    '/r:System.Core.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    join(root, 'scripts', 'twitchpc-tray.cs')
  ],
  { cwd: root, stdio: 'inherit' }
);

copyFileSync(join(root, '.env.example'), join(releaseDir, '.env.example'));
copyFileSync(join(root, 'scripts', 'install-agent.ps1'), join(releaseDir, 'install-agent.ps1'));
copyFileSync(join(root, 'scripts', 'uninstall-agent.ps1'), join(releaseDir, 'uninstall-agent.ps1'));

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const sha256 = createHash('sha256').update(readFileSync(exePath)).digest('hex');
const manifest = { version, sha256, file: 'twitchpc-agent.exe' };
writeFileSync(join(releaseDir, 'version.json'), `${JSON.stringify(manifest, null, 2)}\n`);

writeFileSync(
  join(releaseDir, 'README.txt'),
  [
    'TwitchPC Agent',
    '==============',
    '',
    '1. Copy .env.example to .env in this folder.',
    '2. Fill in CLOUD_URL, EXEC_ALLOWLIST and OBS settings.',
    '3. In the cloud dashboard, click Pair agent and Generate code. The tray app',
    '   will ask for the code automatically. Paste it in and it saves its own',
    '   AGENT_TOKEN into this .env and connects without a restart.',
    '   Right-click the tray icon > Enter pairing code... to do this anytime.',
    '   Alternatively, put AGENT_ID / PAIRING_CODE in this .env before starting.',
    '4. Double-click "TwitchPC Agent.exe" for the system tray app. Click the tray',
    '   icon (or right-click it) to edit settings, pause/resume commands, restart',
    '   the agent, or exit. The hidden twitchpc-agent.exe is the engine.',
    '5. Right-click install-agent.ps1 and choose Run with PowerShell. This adds a',
    '   hidden logon task plus Start Menu > TwitchPC > TwitchPC Agent, and starts',
    '   the tray app at logon. Use uninstall-agent.ps1 to remove all of that.',
    '',
    'Auto-update: if the cloud serves a newer version.json, the agent downloads and',
    'verifies the new exe, then restarts. Set AGENT_AUTO_UPDATE=false to disable.',
    '',
    'No Node.js installation is required on this PC.',
    ''
  ].join('\r\n')
);

rmSync(workDir, { recursive: true, force: true });
console.log(`Built ${exePath}`);
