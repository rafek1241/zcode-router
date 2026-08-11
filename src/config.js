import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const DEFAULT_PORT = 4279;

export function homeDir() {
  return process.env.ZCODE_ROUTER_HOME || path.join(os.homedir(), '.zcode-router');
}

export function configPath() {
  return path.join(homeDir(), 'config.json');
}

export function defaultConfig() {
  return {
    version: 1,
    // Local-only bearer key. zCode presents it; upstream provider keys never leave this file's neighbours.
    localKey: crypto.randomBytes(24).toString('base64url'),
    port: DEFAULT_PORT,
    providers: {},
    visionBridge: { enabled: true, engine: 'auto', local: null },
  };
}

export function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function saveConfig(cfg) {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  harden(dir, true);
  harden(p, false);
}

function harden(target, isDir) {
  if (process.platform === 'win32') {
    try {
      const domain = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : '';
      execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `${domain}${os.userInfo().username}:${isDir ? '(OI)(CI)F' : '(R,W)'}`], { stdio: 'ignore' });
    } catch { /* best effort: %USERPROFILE% ACLs already restrict other users */ }
  } else {
    try { fs.chmodSync(target, isDir ? 0o700 : 0o600); } catch { /* exotic fs */ }
  }
}
