import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, homeDir, killFromPidfile, loadConfig } from './config.js';

const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function dockerDir() {
  return join(homeDir(), 'docker');
}

export function composeFile() {
  return join(dockerDir(), 'docker-compose.yml');
}

export function dockerfileText() {
  return [
    '# Snapshot of the host zcode-router install. Re-run `zcode-router docker` after `zcode-router update`.',
    'FROM node:22-alpine',
    'WORKDIR /app',
    'COPY package.json ./',
    'COPY bin ./bin',
    'COPY src ./src',
    'ENV ZCODE_ROUTER_HOME=/data',
    'ENV ZCODE_ROUTER_BIND=0.0.0.0',
    'CMD ["node", "bin/zcode-router.js", "start"]',
    '',
  ].join('\n');
}

export function composeYaml({ port, dataDir }) {
  const host = dataDir.replaceAll('\\', '/');
  return [
    'services:',
    '  zcode-router:',
    '    build: .',
    '    container_name: zcode-router',
    '    restart: unless-stopped',
    '    ports:',
    `      - "127.0.0.1:${port}:${port}"`,
    '    volumes:',
    `      - "${host}:/data"`,
    '    environment:',
    '      ZCODE_ROUTER_HOME: /data',
    '      ZCODE_ROUTER_BIND: 0.0.0.0',
    '',
  ].join('\n');
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const src = join(from, ent.name);
    const dest = join(to, ent.name);
    if (ent.isDirectory()) copyTree(src, dest);
    else copyFileSync(src, dest);
  }
}

export function writeDockerFiles({ port, dataDir } = {}) {
  const cfg = loadConfig();
  const p = port ?? cfg?.port ?? DEFAULT_PORT;
  const data = dataDir ?? homeDir();
  const dir = dockerDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Dockerfile'), dockerfileText());
  writeFileSync(join(dir, 'docker-compose.yml'), composeYaml({ port: p, dataDir: data }));
  writeFileSync(join(dir, '.dockerignore'), 'node_modules\n');
  copyFileSync(join(pkgRoot, 'package.json'), join(dir, 'package.json'));
  copyTree(join(pkgRoot, 'bin'), join(dir, 'bin'));
  copyTree(join(pkgRoot, 'src'), join(dir, 'src'));
  return dir;
}

export function dockerFilesPresent() {
  return existsSync(composeFile());
}

function composeBin() {
  const v2 = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true });
  if (v2.status === 0) return { cmd: 'docker', prefix: ['compose'] };
  const v1 = spawnSync('docker-compose', ['version'], { encoding: 'utf8', windowsHide: true });
  if (v1.status === 0) return { cmd: 'docker-compose', prefix: [] };
  throw new Error(
    'Docker Compose not found. Install Docker Desktop (Windows/macOS) or docker + compose plugin (Linux), then retry `zcode-router docker`.',
  );
}

function runCompose(args, inherit) {
  const { cmd, prefix } = composeBin();
  return spawnSync(cmd, [...prefix, '-f', composeFile(), ...args], {
    encoding: 'utf8',
    cwd: dockerDir(),
    stdio: inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
}

export function installDocker() {
  if (!loadConfig()) throw new Error('Run `zcode-router setup` first.');
  killFromPidfile();
  const dir = writeDockerFiles();
  const r = runCompose(['up', '-d', '--build'], true);
  if (r.status !== 0) {
    throw new Error(r.error?.message || 'docker compose up --build failed');
  }
  return { dir, port: loadConfig().port ?? DEFAULT_PORT };
}

export function dockerDown() {
  if (!dockerFilesPresent()) throw new Error('No Docker install. Run `zcode-router docker` first.');
  const r = runCompose(['down'], true);
  if (r.status !== 0) throw new Error(r.error?.message || 'docker compose down failed');
}

export function dockerStatus() {
  if (!dockerFilesPresent()) return { installed: false, detail: 'no compose file' };
  try {
    const r = runCompose(['ps'], false);
    return { installed: true, detail: (r.stdout || r.stderr || '').trim() };
  } catch (e) {
    return { installed: true, detail: e.message };
  }
}
