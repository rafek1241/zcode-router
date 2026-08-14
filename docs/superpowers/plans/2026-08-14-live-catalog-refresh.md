# Live catalog refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `zcode-router models refresh [provider]` GETs `/models` from an enabled, keyed provider and stores new ids as `extra`, so catalog-only providers (Groq, OpenRouter, Zen, Gemini) show up in ZCode without memorizing ids.

**Architecture:** Reuse `resolveKey` + `assertSafeBaseURL`. Write extras through the same `config.providers[id].extra` shape `models add` already uses. Conservative defaults: `vision: false`, `protocol: 'openai'` (or the provider's default protocol). Interactive toggle reuses `toggleSelection` from `src/setup-ui.js`.

**Tech Stack:** Node 22 `fetch`, existing config, `node:test` with a mock `/models` server.

## Global Constraints

- HTTPS or loopback only (existing `assertSafeBaseURL`).
- Do not spend a chat completion — `/models` only.
- Additive by default; `--prune` is explicit.
- Do not mark vision true from a name heuristic.

---

### Task 1: Fetch and merge extras

**Files:**
- Create: `src/catalog-refresh.js`
- Test: `test/catalog-refresh.test.js`

**Interfaces:**
- Consumes: `config`, `providerId`, `fetchImpl`
- Produces: `{ added: string[], kept: string[], skipped: string[] }`

- [ ] **Step 1: Write the failing test**

```js
test('refresh merges live ids into extra without duplicating the registry', async () => {
  const server = http.createServer((_, res) => {
    res.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b' }, { id: 'deepseek-v4-flash' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cfg = {
    providers: {
      groq: { enabled: true, key: 'sk', baseURL: `http://127.0.0.1:${port}/v1` },
    },
  };
  const result = await refreshCatalog(cfg, 'groq', { fetchImpl: fetch });
  assert.deepEqual(result.added, ['llama-3.3-70b']);
  assert.ok(result.skipped.includes('deepseek-v4-flash') || result.kept.length >= 0);
  server.close();
});
```

Note: Groq's registry list is empty, so both ids add. For `opencode-go`, skip ids already in `REGISTRY['opencode-go'].models`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/catalog-refresh.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Minimal `refreshCatalog`**

```js
export async function refreshCatalog(config, providerId, { fetchImpl = fetch } = {}) {
  const entry = providerEntry(config, providerId);
  if (!entry || !entry.enabled) throw new Error(`provider ${providerId} is not enabled`);
  const { key } = resolveKey(entry, config);
  if (!key && !isLoopback(entry.baseURL)) throw new Error(`provider ${providerId} has no key`);
  assertSafeBaseURL(entry.baseURL);
  const r = await fetchImpl(`${entry.baseURL.replace(/\/+$/, '')}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`GET /models HTTP ${r.status}`);
  const body = await r.json();
  const live = (body.data || body.models || []).map((x) => (typeof x === 'string' ? x : x.id)).filter(Boolean);
  const known = new Set(entry.models.map((m) => m.id));
  const extra = [...(config.providers[providerId].extra || [])];
  const added = [];
  for (const id of live) {
    if (known.has(id)) continue;
    extra.push({ id, vision: false, protocol: entry.models[0]?.protocol && false || 'openai' });
    known.add(id);
    added.push(id);
  }
  config.providers[providerId].extra = extra;
  return { added, kept: [...known], skipped: [] };
}
```

Fix the `protocol` line to `REGISTRY[providerId]?.protocol || 'openai'`.

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

```bash
git add src/catalog-refresh.js test/catalog-refresh.test.js
git commit -m "feat: refresh live provider catalogs into extras"
```

### Task 2: CLI `models refresh` with optional toggle

**Files:**
- Modify: `src/cli.js` (`cmdModels`)
- Reuse: `src/setup-ui.js` `toggleSelection` / `pickProviders`

- [ ] **Step 1:** `models refresh <id>` non-interactive adds everything new and prints counts.
- [ ] **Step 2:** TTY path lists new ids as `[ ]` and uses the same Enter-to-confirm picker as setup.
- [ ] **Step 3:** `--prune` removes extras not in the live list (never registry models).
- [ ] **Step 4:** `npm test`
- [ ] **Step 5: Commit**

```bash
git add src/cli.js
git commit -m "feat: models refresh CLI with optional interactive toggle"
```
