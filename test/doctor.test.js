import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDoctorChecks, formatDoctorReport, applyDoctorFixes } from '../src/doctor.js';
import { saveConfig, defaultConfig, configPath } from '../src/config.js';

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-router-doctor-'));
  const prev = process.env.ZCODE_ROUTER_HOME;
  process.env.ZCODE_ROUTER_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.ZCODE_ROUTER_HOME;
    else process.env.ZCODE_ROUTER_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('collectDoctorChecks fails when there is no config', async (t) => {
  tempHome(t);
  const { checks, failed } = await collectDoctorChecks({
    fetchImpl: async () => { throw new Error('offline'); },
    service: () => ({ installed: false }),
    docker: () => ({ installed: false }),
  });
  assert.ok(failed >= 1);
  assert.ok(checks.some((c) => c.name === 'config file' && c.status === 'fail'));
});

test('collectDoctorChecks reports enabled providers missing keys and prints zCode settings when healthy', async (t) => {
  tempHome(t);
  const cfg = defaultConfig();
  cfg.providers.deepseek = { enabled: true };
  cfg.providers['opencode-go'] = { enabled: true, key: 'sk-oc' };
  saveConfig(cfg);

  const { checks, failed, config } = await collectDoctorChecks({
    fetchImpl: async () => { throw new Error('offline'); },
    service: () => ({ installed: false, detail: 'none' }),
    docker: () => ({ installed: false }),
  });
  assert.ok(config.localKey);
  assert.ok(checks.some((c) => c.name === 'provider deepseek' && c.status === 'fail'));
  assert.ok(checks.some((c) => c.name === 'provider opencode-go' && c.status === 'ok'));
  assert.ok(failed >= 1);

  const report = formatDoctorReport({ checks, failed, config });
  assert.match(report, /FAIL\s+provider deepseek/);
  assert.match(report, /OK\s+provider opencode-go/);
  assert.match(report, /Base URL:/);
  assert.match(report, /API Key:/);
});

test('applyDoctorFixes restores config mode 0600', async (t) => {
  if (process.platform === 'win32') return;
  tempHome(t);
  const cfg = defaultConfig();
  saveConfig(cfg);
  fs.chmodSync(configPath(), 0o644);
  const result = applyDoctorFixes({ config: cfg });
  assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  assert.ok(result.fixed.some((item) => item.includes('permissions')));
});

test('collectDoctorChecks --probe hits GET /models with the stored key', async (t) => {
  tempHome(t);
  const cfg = defaultConfig();
  cfg.providers.deepseek = { enabled: true, key: 'sk-probe' };
  saveConfig(cfg);
  const calls = [];
  await collectDoctorChecks({
    probe: true,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), auth: init?.headers?.authorization });
      if (String(url).includes('/health')) throw new Error('down');
      return { ok: true, status: 200 };
    },
    service: () => ({ installed: false }),
    docker: () => ({ installed: false }),
  });
  assert.ok(calls.some((c) => c.url.includes('api.deepseek.com') && c.auth === 'Bearer sk-probe'));
});
