import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function zcodeConfigPath() {
  return process.env.ZCODE_CONFIG || path.join(os.homedir(), '.zcode', 'v2', 'config.json');
}

function looksLikeOurRouter(value, port) {
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (!(v.includes('127.0.0.1') || v.includes('localhost'))) return false;
    if (port && v.includes(`:${port}`)) return true;
    return v.includes('zcode-router');
  }
  if (Array.isArray(value)) return value.some((item) => looksLikeOurRouter(item, port));
  if (value && typeof value === 'object') return Object.values(value).some((item) => looksLikeOurRouter(item, port));
  return false;
}

function patchModel(model) {
  if (!model || typeof model !== 'object') return false;
  const modalities = model.modalities && typeof model.modalities === 'object' ? model.modalities : (model.modalities = {});
  const inputs = Array.isArray(modalities.input) ? modalities.input : [];
  const next = [];
  for (const m of ['text', 'image', ...inputs]) if (!next.includes(m)) next.push(m);
  const changed = JSON.stringify(inputs) !== JSON.stringify(next) || model.supportsImages !== true;
  modalities.input = next;
  if (!Array.isArray(modalities.output) || modalities.output.length === 0) modalities.output = ['text'];
  model.supportsImages = true;
  return changed;
}

// zCode caches modalities.input from the first model fetch and then omits
// screenshots client-side. Patch every custom provider that points at this
// router so a Refresh is not enough — the on-disk cache has to say "image".
export function patchZcodeConfig({ port, configPath = zcodeConfigPath() } = {}) {
  if (!fs.existsSync(configPath)) return { ok: false, reason: 'no-config', path: configPath, patched: 0 };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: err.message, path: configPath, patched: 0 };
  }
  const providers = data.provider || data.providers || {};
  if (typeof providers !== 'object' || Array.isArray(providers)) {
    return { ok: false, reason: 'unexpected-schema', path: configPath, patched: 0 };
  }
  let patched = 0;
  const names = [];
  for (const [id, provider] of Object.entries(providers)) {
    if (typeof id === 'string' && id.startsWith('builtin:')) continue;
    if (!provider || typeof provider !== 'object') continue;
    if (!looksLikeOurRouter(provider, port)) continue;
    const models = provider.models && typeof provider.models === 'object' ? provider.models : {};
    for (const model of Object.values(models)) {
      if (patchModel(model)) patched += 1;
    }
    names.push(provider.name || id);
  }
  if (patched === 0) return { ok: true, patched: 0, path: configPath, names };
  const backup = `${configPath}.zcode-router-bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup);
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n');
  return { ok: true, patched, path: configPath, names, backup };
}
