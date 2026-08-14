# Auto-register the ZCode provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `setup` / `start` writes the custom provider into `~/.zcode/v2/config.json` so the user never copies Base URL and loopback key by hand.

**Architecture:** Extend `src/zcode-config.js` (already patches image modalities on an existing router provider) to also upsert a `zcode-router` provider entry. Keep the current backup file. Fail closed if the zCode schema is missing or unreadable.

**Tech Stack:** Node 22, existing `src/zcode-config.js`, `node:test`.

## Global Constraints

- Loopback only: Base URL is always `http://127.0.0.1:<port>/v1`.
- Never write upstream provider keys into zCode config — only `config.localKey`.
- Do not overwrite an unrelated custom provider; match with the existing `looksLikeOurRouter` helper.
- Zero new dependencies.

---

### Task 1: Upsert the router provider in zCode config

**Files:**
- Modify: `src/zcode-config.js`
- Test: `test/zcode-config.test.js`

**Interfaces:**
- Consumes: `patchZcodeConfig({ port, configPath, localKey })`
- Produces: `{ ok, patched, registered, path, backup, names }`

- [ ] **Step 1: Write the failing test**

```js
test('patchZcodeConfig registers a zcode-router provider when none exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-cfg-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ provider: {} }) + '\n');
  const result = patchZcodeConfig({ port: 4279, localKey: 'loopback-key', configPath });
  assert.equal(result.ok, true);
  assert.equal(result.registered, 1);
  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const entry = Object.values(data.provider).find((p) => p.name === 'zcode-router');
  assert.equal(entry.baseUrl || entry.baseURL, 'http://127.0.0.1:4279/v1');
  assert.equal(entry.apiKey || entry.key, 'loopback-key');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/zcode-config.test.js`
Expected: FAIL — `registered` is undefined / no provider inserted.

- [ ] **Step 3: Write minimal implementation**

In `patchZcodeConfig`, after the existing modality loop, if no provider matched `looksLikeOurRouter`, insert one object using the same field names zCode already stores for custom Anthropic-style providers (inspect a real `~/.zcode/v2/config.json` in the test fixture — copy the shape from `test/zcode-config.test.js` existing cases). Set `supportsImages` / `modalities.input` to include `image` in the same function.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/zcode-config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/zcode-config.js test/zcode-config.test.js
git commit -m "feat: register the zCode provider from setup/start"
```

### Task 2: Call upsert from setup, start, and doctor --fix

**Files:**
- Modify: `src/cli.js` (`cmdSetup`, `cmdStart`)
- Modify: `src/doctor.js` (`applyDoctorFixes`)

- [ ] **Step 1: Pass `localKey` into every `patchZcodeConfig` call**
- [ ] **Step 2: doctor --fix reports `registered` in `fixed[]`**
- [ ] **Step 3: `npm test` + `npm run selftest`**
- [ ] **Step 4: Commit**

```bash
git add src/cli.js src/doctor.js
git commit -m "feat: upsert zCode provider during setup, start, and doctor --fix"
```
