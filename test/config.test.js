import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig, loadConfig, configPath, bindHost } from '../src/config.js';

test('config round-trips with restrictive permissions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-router-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.ZCODE_ROUTER_HOME = dir;
  t.after(() => delete process.env.ZCODE_ROUTER_HOME);

  const cfg = defaultConfig();
  assert.equal(cfg.localKey.length, 32);
  cfg.providers.deepseek = { enabled: true, key: 'sk-secret' };
  saveConfig(cfg);

  const loaded = loadConfig();
  assert.equal(loaded.providers.deepseek.key, 'sk-secret');

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});

test('two default configs never share a local key', () => {
  assert.notEqual(defaultConfig().localKey, defaultConfig().localKey);
});

test('bindHost is loopback unless ZCODE_ROUTER_BIND=0.0.0.0', (t) => {
  const prev = process.env.ZCODE_ROUTER_BIND;
  t.after(() => {
    if (prev === undefined) delete process.env.ZCODE_ROUTER_BIND;
    else process.env.ZCODE_ROUTER_BIND = prev;
  });
  delete process.env.ZCODE_ROUTER_BIND;
  assert.equal(bindHost(), '127.0.0.1');
  process.env.ZCODE_ROUTER_BIND = '0.0.0.0';
  assert.equal(bindHost(), '0.0.0.0');
  process.env.ZCODE_ROUTER_BIND = '192.168.1.5';
  assert.equal(bindHost(), '127.0.0.1');
});
