# Last-error doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a failed upstream call, `zcode-router doctor` (and `doctor last`) print the last error in plain language — provider, catalog id, upstream id, HTTP status, truncated body — so a transparent local proxy is debuggable without `--verbose` or a packet dump.

**Architecture:** Write a 0600 JSON file `~/.zcode-router/last-error.json` from `handleChat` on non-2xx / network failure. Redact with existing `redactSecrets`. `collectDoctorChecks` adds an `info` or `fail` row when the file is newer than 24h.

**Tech Stack:** `src/server.js`, `src/debug.js` `redactSecrets`, `src/doctor.js`.

## Global Constraints

- Never store upstream API keys or `localKey`.
- Cap the saved body at 1 KiB after redaction.
- Do not change the bytes forwarded to ZCode.

---

### Task 1: Record last error

**Files:**
- Create: `src/last-error.js`
- Modify: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `{ providerId, routedId, upstreamModel, status, detail, at }`
- Produces: file at `path.join(homeDir(), 'last-error.json')`

- [ ] **Step 1: Write the failing test**

```js
test('non-2xx upstream is remembered for doctor', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-err-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.ZCODE_ROUTER_HOME = dir;
  const { chat } = await makeRig(t, {
    upstreamHandler: (_req, res) => { res.writeHead(429).end('{"error":"quota"}'); },
  });
  await chat({ model: 'mock/mock-text', messages: [{ role: 'user', content: 'x' }] });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'last-error.json'), 'utf8'));
  assert.equal(saved.status, 429);
  assert.equal(saved.routedId, 'mock/mock-text');
  assert.match(saved.detail, /quota/);
});
```

`makeRig` currently always returns 200 — pass a custom `upstreamHandler` (already supported).

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: `recordLastError` + call it next to the existing 502/status logs in `handleChat`**
- [ ] **Step 4: Tests pass**
- [ ] **Step 5: Commit**

```bash
git add src/last-error.js src/server.js test/server.test.js
git commit -m "feat: persist last upstream error for doctor"
```

### Task 2: Surface it from doctor

**Files:**
- Modify: `src/doctor.js` `collectDoctorChecks`
- Modify: `src/cli.js` — `doctor last` prints the file or "none"

- [ ] **Step 1:** Add check `last upstream error` with status `info` if missing/expired, `warn` if present.
- [ ] **Step 2:** `doctor last` exits 0 when no file, 1 when the last error was HTTP >= 400 (so scripts can wait on a clean turn).
- [ ] **Step 3:** `npm test`
- [ ] **Step 4: Commit**

```bash
git add src/doctor.js src/cli.js test/doctor.test.js
git commit -m "feat: doctor last prints the saved upstream error"
```
