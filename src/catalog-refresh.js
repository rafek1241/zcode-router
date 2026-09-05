import { REGISTRY, listProviders, providerEntry, resolveKey, assertSafeBaseURL, isLoopback, probeHeaders } from './providers.js';

/** Model id whether the extra is stored as a string or an object. */
function extraId(model) {
  return typeof model === 'string' ? model : model.id;
}

/**
 * GET `<baseURL>/models` and merge novel live ids into the provider's stored
 * extras (registry rows are never duplicated). `prune` drops extras missing
 * from the live list; `select` filters which novel ids are kept.
 */
export async function refreshCatalog(config, providerId, { fetchImpl = fetch, prune = false, select } = {}) {
  const entry = providerEntry(config, providerId);
  if (!entry || !entry.enabled) throw new Error(`provider ${providerId} is not enabled`);
  const { key } = resolveKey(entry, config);
  if (!key && !isLoopback(entry.baseURL)) throw new Error(`provider ${providerId} has no key`);
  assertSafeBaseURL(entry.baseURL);
  const r = await fetchImpl(`${entry.baseURL.replace(/\/+$/, '')}/models`, {
    headers: probeHeaders(entry, key),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`GET /models HTTP ${r.status}`);
  const body = await r.json();
  const live = (body.data || body.models || []).map((x) => (typeof x === 'string' ? x : x.id)).filter(Boolean);
  const registryIds = new Set((REGISTRY[providerId]?.models || []).map((m) => m.id));
  const slot = config.providers[providerId] || (config.providers[providerId] = { enabled: true });
  const extra = [...(slot.extra || [])];
  const extraIds = new Set(extra.map(extraId));
  const skipped = [];
  const kept = [];
  const novel = [];
  for (const id of live) {
    if (registryIds.has(id)) {
      skipped.push(id);
      continue;
    }
    if (extraIds.has(id)) {
      kept.push(id);
      continue;
    }
    novel.push(id);
  }
  const picked = select ? await select(novel) : novel;
  const pickedSet = new Set(picked);
  const added = [];
  const protocol = REGISTRY[providerId]?.protocol || 'openai';
  for (const id of novel) {
    if (!pickedSet.has(id)) continue;
    extra.push({ id, protocol }); // no vision flag: support resolves dynamically
    extraIds.add(id);
    added.push(id);
  }
  const liveSet = new Set(live);
  let nextExtra = extra;
  const pruned = [];
  if (prune) {
    nextExtra = extra.filter((m) => {
      const id = extraId(m);
      if (liveSet.has(id)) return true;
      pruned.push(id);
      return false;
    });
  }
  slot.extra = nextExtra;
  return { added, kept, skipped, pruned };
}

/**
 * The registry keeps only wire-protocol exceptions, so an enabled provider can
 * have zero models (fresh key, or an upgrade from a preset-seeded registry).
 * Each such provider pulls its live list once — same thing setup does after
 * keys — instead of serving an empty catalog until the next
 * `setup`/`models refresh`. Best-effort: offline or odd upstreams stay empty.
 * Returns the ids that gained models.
 */
export async function refreshEmptyProviders(config, { fetchImpl = fetch, log = () => {} } = {}) {
  const refreshed = [];
  for (const entry of listProviders(config)) {
    if (!entry.enabled || entry.custom) continue;
    if (entry.models.length > 0) continue;
    if (!resolveKey(entry, config).key && !isLoopback(entry.baseURL)) continue;
    try {
      const result = await refreshCatalog(config, entry.id, { fetchImpl });
      if (result.added.length) {
        log(`${entry.id}: picked up ${result.added.length} model(s) from live /models`);
        refreshed.push(entry.id);
      }
    } catch {
      /* stays empty until `models refresh` */
    }
  }
  return refreshed;
}
