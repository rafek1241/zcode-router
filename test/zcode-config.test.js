import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchZcodeConfig } from '../src/zcode-config.js';

test('patchZcodeConfig sets image modality on the loopback router provider only', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      provider: {
        'builtin:zai': { name: 'Z.ai', models: { 'glm-5.2': { modalities: { input: ['text'] } } } },
        'dac84aac-3e8d-4992-9cb6-7c571da9aa47': {
          name: 'zcode-router',
          options: { baseURL: 'http://127.0.0.1:4279/v1' },
          models: {
            'opencode-go/deepseek-v4-flash': { modalities: { input: ['text'], output: ['text'] } },
            'opencode-go/minimax-m3': { supportsImages: false },
          },
        },
        other: {
          name: 'ollama',
          options: { baseURL: 'http://127.0.0.1:11434/v1' },
          models: { llama: { modalities: { input: ['text'] } } },
        },
      },
    })
  );

  const result = patchZcodeConfig({ port: 4279, configPath });
  assert.equal(result.ok, true);
  assert.equal(result.patched, 2);
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const flash = after.provider['dac84aac-3e8d-4992-9cb6-7c571da9aa47'].models['opencode-go/deepseek-v4-flash'];
  assert.deepEqual(flash.modalities.input, ['text', 'image']);
  assert.equal(flash.supportsImages, true);
  assert.deepEqual(after.provider['builtin:zai'].models['glm-5.2'].modalities.input, ['text']);
  assert.deepEqual(after.provider.other.models.llama.modalities.input, ['text']);
  assert.equal(fs.existsSync(`${configPath}.zcode-router-bak`), true);
  assert.equal(result.registered, 0);
});

test('patchZcodeConfig registers a zcode-router provider when none exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-cfg-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      provider: {
        'builtin:zai': { name: 'Z.ai', models: { 'glm-5.2': { modalities: { input: ['text'] } } } },
        other: {
          name: 'ollama',
          options: { baseURL: 'http://127.0.0.1:11434/v1' },
          models: { llama: { modalities: { input: ['text'] } } },
        },
      },
    }) + '\n'
  );
  const result = patchZcodeConfig({ port: 4279, localKey: 'loopback-key', configPath });
  assert.equal(result.ok, true);
  assert.equal(result.registered, 1);
  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entry = Object.values(data.provider).find((p) => p.name === 'zcode-router');
  assert.ok(entry, 'inserted a named zcode-router provider');
  assert.equal(entry.options.baseURL, 'http://127.0.0.1:4279/v1');
  assert.equal(entry.options.apiKey, 'loopback-key');
  assert.deepEqual(data.provider['builtin:zai'].models['glm-5.2'].modalities.input, ['text']);
  assert.deepEqual(data.provider.other.models.llama.modalities.input, ['text']);
  assert.equal(fs.existsSync(`${configPath}.zcode-router-bak`), true);
});

test('patchZcodeConfig does not register without a localKey', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-cfg-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ provider: {} }) + '\n');
  const result = patchZcodeConfig({ port: 4279, configPath });
  assert.equal(result.ok, true);
  assert.equal(result.registered, 0);
  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(Object.keys(data.provider).length, 0);
});
