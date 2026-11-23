import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    '3. In the cloud dashboard, click Pair agent and Generate code. Copy the',
    '   AGENT_ID / PAIRING_CODE lines into this .env, then start the agent once.',
    '   It saves its own AGENT_TOKEN back into this file and clears PAIRING_CODE.',
    '   Alternatively, set AGENT_TOKEN to exactly the cloud AGENT_TOKEN value.',
    '4. Optional: right-click install-agent.ps1 and choose Run with PowerShell.',
    '   This installs a hidden logon task so the agent starts automatically.',
    '   Use uninstall-agent.ps1 to remove it.',
    '5. Without the task, double-click twitchpc-agent.exe and leave the console open.',
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
