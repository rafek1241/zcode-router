import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { configPath, DEFAULT_PORT, homeDir, loadConfig } from './config.js';
import { catalog, isLoopback, listProviders, resolveKey, assertSafeBaseURL, probeHeaders } from './providers.js';
import { resolveVisionEngine } from './server.js';
import { dockerFilesPresent, dockerStatus } from './docker.js';
import { describeServiceTarget, localDir, serviceStatus } from './service.js';
import { patchZcodeConfig, zcodeConfigPath } from './zcode-config.js';
import { readLastError, formatLastError } from './last-error.js';

function add(checks, status, name, detail = '') {
  checks.push({ status, name, detail });
}

async function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

export async function collectDoctorChecks({
  probe = false,
  fetchImpl = fetch,
  service = serviceStatus,
  docker = dockerStatus,
} = {}) {
  const checks = [];
  let cfg = null;
  try {
    cfg = loadConfig();
    add(checks, cfg ? 'ok' : 'fail', 'config file', configPath());
  } catch (e) {
    add(checks, 'fail', 'config file', `${configPath()}: ${e.message}`);
    return { checks, failed: 1, config: null };
  }
  if (!cfg) return { checks, failed: 1, config: null };

  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(configPath()).mode & 0o777;
      add(checks, mode === 0o600 ? 'ok' : 'fail', 'config permissions', `mode ${mode.toString(8)}`);
    } catch (e) {
      add(checks, 'fail', 'config permissions', e.message);
    }
  }

  add(checks, typeof cfg.localKey === 'string' && cfg.localKey.length >= 16 ? 'ok' : 'fail', 'local key present');

  const port = cfg.port || DEFAULT_PORT;
  const running = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (running) {
    add(checks, 'ok', 'router process', `127.0.0.1:${port} responding`);
  } else {
    const free = await portFree(port);
    add(checks, free ? 'ok' : 'fail', 'port available', `127.0.0.1:${port} ${free ? 'free' : 'in use by another process'}`);
  }

  const models = catalog(cfg);
  add(checks, models.length > 0 ? 'ok' : 'fail', 'routable models', models.length ? `${models.length} model(s)` : 'none — run setup');

  for (const p of listProviders(cfg)) {
    if (!p.enabled) continue;
    const { key, source } = resolveKey(p, cfg);
    const keyless = isLoopback(p.baseURL);
    add(
      checks,
      key || keyless ? 'ok' : 'fail',
      `provider ${p.id}`,
      key ? `key from ${source}` : keyless ? 'loopback, no key needed' : 'NO KEY'
    );
    if (probe) {
      if (keyless) {
        add(checks, 'info', `provider ${p.id} probe`, 'skipped (loopback)');
      } else if (key) {
        try {
          assertSafeBaseURL(p.baseURL);
          const r = await fetchImpl(`${p.baseURL.replace(/\/+$/, '')}/models`, {
            headers: probeHeaders(p, key),
            signal: AbortSignal.timeout(10_000),
          });
          let detail = `GET /models -> HTTP ${r.status} (free call)`;
          if (r.ok && p.id === 'commandcode') {
            detail += ' — /models 200 does not prove chat; Provider plan required';
          }
          add(checks, r.ok ? 'ok' : 'fail', `provider ${p.id} probe`, detail);
        } catch (e) {
          add(checks, 'fail', `provider ${p.id} probe`, e.message);
        }
      }
    }
  }

  const vb = cfg.visionBridge;
  if (vb?.enabled === false) {
    add(checks, 'info', 'vision bridge', 'disabled — images to text-only models will be refused by the provider');
  } else {
    const engine = resolveVisionEngine(cfg);
    add(
      checks,
      'info',
      'vision bridge engine',
      engine ? engine.label : 'none available — pin one with `vision-bridge engine <provider/model>` to enable image pasting'
    );
  }

  const last = readLastError();
  if (!last) add(checks, 'info', 'last upstream error', 'none');
  else add(checks, 'warn', 'last upstream error', formatLastError(last).split('\n')[0]);

  const zpath = zcodeConfigPath();
  add(checks, 'info', 'zCode config', `${zpath}${fs.existsSync(zpath) ? '' : ' (not found)'}`);
  const st = service();
  add(checks, 'info', 'background service', `${st.installed ? 'installed' : 'not installed'} — ${describeServiceTarget()}`);
  add(
    checks,
    'info',
    'service snapshot',
    fs.existsSync(path.join(localDir(), 'bin', 'zcode-router.js')) ? `present in ${localDir()}` : 'none'
  );
  const dock = docker();
  add(
    checks,
    'info',
    'docker',
    dock.installed || dockerFilesPresent() ? `compose files in ${path.join(homeDir(), 'docker')}` : 'not installed'
  );

  const failed = checks.filter((c) => c.status === 'fail').length;
  return { checks, failed, config: cfg };
}

export function formatDoctorReport({ checks, failed, config }) {
  const tag = { ok: ' OK ', fail: 'FAIL', info: 'INFO', warn: 'WARN' };
  const lines = checks.map((c) => `${tag[c.status] || c.status}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  if (failed > 0) lines.push('', `${failed} check(s) failed.`);
  if (config) {
    lines.push(
      '',
      'ZCode setup (Settings → Model Settings → Add Provider):',
      '  Name:     zcode-router',
      `  Base URL: http://127.0.0.1:${config.port || DEFAULT_PORT}/v1`,
      `  API Key:  ${config.localKey}`,
      'zCode will fetch the model list automatically. The key is loopback-only — do not share it.',
      'After changing the router, click Refresh on this provider and start a new chat — zCode caches whether a model accepts images.'
    );
  }
  return lines.join('\n');
}

export function applyDoctorFixes({ config } = {}) {
  const cfg = config || loadConfig();
  const fixed = [];
  if (!cfg) return { fixed, errors: ['no config'] };
  const p = configPath();
  if (process.platform !== 'win32' && fs.existsSync(p)) {
    fs.chmodSync(p, 0o600);
    fixed.push(`config permissions -> 0600 (${p})`);
  }
  const patched = patchZcodeConfig({ port: cfg.port, localKey: cfg.localKey, config: cfg });
  if (patched.ok && patched.registered > 0) {
    fixed.push('zCode config: registered zcode-router provider');
  }
  if (patched.ok && patched.filled > 0) {
    fixed.push(`zCode config: pre-filled ${patched.filled} model record(s) from the router catalog`);
  }
  if (patched.ok && patched.patched > 0) {
    fixed.push(`zCode config: image input on ${patched.patched} model(s)`);
  }
  return { fixed, errors: [] };
}
