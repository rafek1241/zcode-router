// Dynamic vision capability lookup. No hardcoded model table: image support is
// read from public model catalogs — models.dev first (it even tracks our
// `opencode-go/*` subscription ids), OpenRouter as fallback. Unknown or
// unreachable means "text-only" (bridge), never a broken native send.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './config.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const VISION_CACHE_TTL_MS = 24 * 3600 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

function visionCachePath() {
  return path.join(homeDir(), 'vision-sources-cache.json');
}

// `opencode-go/Omen-Alpha` and `xai/grok-4.5:batch` must hit the same key as
// `omen-alpha` and `grok-4.5`; separators are noise (`claude-opus-4-8` upstream
// vs `claude-opus-4.8` in catalogs).
export function visionKey(id) {
  return String(id || '').toLowerCase().split(':')[0].replace(/[-_.]/g, '');
}

function shortKey(id) {
  const base = String(id || '').toLowerCase().split(':')[0];
  return visionKey(base.slice(base.lastIndexOf('/') + 1));
}

function hasImage(modalities) {
  return Array.isArray(modalities) && modalities.map((m) => String(m).toLowerCase()).includes('image');
}

// One pass over a catalog accumulates votes per model: an `opencode-go/*`
// entry (the ids this router actually serves) beats a majority vote, which
// beats first-seen order (one provider ships stale flags; JSON order is
// arbitrary).
function vote(votes, full, short, vision, authoritative) {
  for (const key of [full, short]) {
    if (!key) continue;
    const v = votes.get(key) || { yes: 0, no: 0, auth: undefined };
    if (authoritative) v.auth = vision;
    else vision ? (v.yes += 1) : (v.no += 1);
    votes.set(key, v);
  }
}

function votesToIndex(votes) {
  const index = new Map();
  for (const [key, v] of votes) {
    index.set(key, v.auth !== undefined ? v.auth : v.yes > v.no);
  }
  return index;
}

export function indexModelsDev(json) {
  const votes = new Map();
  const providers = json && typeof json === 'object' ? json : {};
  for (const [providerId, provider] of Object.entries(providers)) {
    const models = provider?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelId, model] of Object.entries(models)) {
      const full = visionKey(`${providerId}/${modelId}`);
      vote(votes, full, shortKey(modelId), hasImage(model?.modalities?.input), visionKey(providerId) === 'opencodego');
    }
  }
  return votesToIndex(votes);
}

export function indexOpenRouter(json) {
  const votes = new Map();
  const rows = Array.isArray(json?.data) ? json.data : [];
  for (const row of rows) {
    if (!row?.id) continue;
    vote(votes, visionKey(row.id), shortKey(row.id), hasImage(row?.architecture?.input_modalities), false);
  }
  return votesToIndex(votes);
}

async function fetchJson(fetchImpl, url) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return r.json();
}

function readDiskCache(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.fetchedAt === 'number' && raw.index && typeof raw.index === 'object') {
      return { fetchedAt: raw.fetchedAt, index: new Map(Object.entries(raw.index)) };
    }
  } catch {
    /* missing or corrupt — refetch */
  }
  return null;
}

function writeDiskCache(cachePath, index) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), index: Object.fromEntries(index) }));
  } catch {
    /* cache is best-effort */
  }
}

let mem = null; // { fetchImpl, at, ttl, index } — one fetchImpl per process in practice

export function clearVisionCapabilitiesCache() {
  mem = null;
}

export async function getVisionIndex({ fetchImpl = fetch, cachePath = visionCachePath() } = {}) {
  const now = Date.now();
  if (mem && mem.fetchImpl === fetchImpl && now - mem.at < mem.ttl) return mem.index;
  const disk = readDiskCache(cachePath);
  if (disk && now - disk.fetchedAt < VISION_CACHE_TTL_MS) {
    mem = { fetchImpl, at: disk.fetchedAt, ttl: VISION_CACHE_TTL_MS, index: disk.index };
    return disk.index;
  }
  let index = null;
  try {
    index = indexModelsDev(await fetchJson(fetchImpl, MODELS_DEV_URL));
  } catch {
    try {
      index = indexOpenRouter(await fetchJson(fetchImpl, OPENROUTER_URL));
    } catch {
      index = null;
    }
  }
  if (index) {
    writeDiskCache(cachePath, index);
    mem = { fetchImpl, at: now, ttl: VISION_CACHE_TTL_MS, index };
    return index;
  }
  mem = { fetchImpl, at: now, ttl: FAIL_TTL_MS, index: new Map() };
  return mem.index;
}

export function lookupVision(index, id) {
  if (!id || !index) return null;
  const full = visionKey(id);
  if (index.has(full)) return index.get(full);
  const short = shortKey(id);
  if (short !== full && index.has(short)) return index.get(short);
  return null;
}

// Majority votes disagree across providers (or the disk cache holds them), so
// surface the cache age for `doctor`.
export function visionSourcesStatus(cachePath = visionCachePath()) {
  try {
    const ageMs = Date.now() - fs.statSync(cachePath).mtimeMs;
    return { ageMs, path: cachePath };
  } catch {
    return { ageMs: null, path: cachePath };
  }
}
