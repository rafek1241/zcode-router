import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordLastError, readLastError, formatLastError } from '../src/last-error.js';

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-router-err-'));
  const prev = process.env.ZCODE_ROUTER_HOME;
  process.env.ZCODE_ROUTER_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.ZCODE_ROUTER_HOME;
    else process.env.ZCODE_ROUTER_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('recordLastError redacts secrets, caps detail, and uses mode 0600', (t) => {
  if (process.platform === 'win32') return;
  const dir = tempHome(t);
  recordLastError({
    providerId: 'deepseek',
    routedId: 'deepseek/deepseek-v4-flash',
    upstreamModel: 'deepseek-v4-flash',
    status: 401,
    detail: `Bearer sk-abcdefghijklmnopqrstuvwxyz ${'x'.repeat(2000)}`,
  });
  const p = path.join(dir, 'last-error.json');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.doesNotMatch(saved.detail, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.ok(saved.detail.length <= 1024);
  assert.equal(readLastError().status, 401);
  assert.match(formatLastError(saved), /deepseek\/deepseek-v4-flash/);
});

test('readLastError treats missing and expired files as none', (t) => {
  const dir = tempHome(t);
  assert.equal(readLastError(), null);
  fs.writeFileSync(
    path.join(dir, 'last-error.json'),
    JSON.stringify({ status: 500, routedId: 'x', at: Date.now() - 25 * 3600 * 1000 })
  );
  assert.equal(readLastError({ maxAgeMs: 24 * 3600 * 1000 }), null);
  assert.equal(readLastError({ maxAgeMs: Infinity }).status, 500);
});
