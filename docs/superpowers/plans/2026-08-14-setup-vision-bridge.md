# Setup vision-bridge step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After provider toggle + keys, setup asks how screenshots should work, so a DeepSeek-only install does not silently lose image pastes.

**Architecture:** Insert one more loop in `cmdSetup` between key collection and the Docker/service prompt. Options: `auto` (current default), pin a vision-capable model from the just-enabled catalog, `local` (LM Studio / Ollama URL), or `off`. Reuse `autoVisionEngine` and `assertSafeBaseURL`.

**Tech Stack:** Existing `src/cli.js` setup, `src/providers.js`, `src/server.js` `resolveVisionEngine`.

## Global Constraints

- Do not add a GUI. One numbered prompt, same style as the deployment choice.
- Local engines stay loopback HTTP; anything else must be HTTPS.
- Skipping (empty Enter) keeps `engine: 'auto'`.

---

### Task 1: Pure chooser

**Files:**
- Modify: `src/setup-ui.js`
- Test: `test/setup-ui.test.js`

**Interfaces:**
- Consumes: `{ hasVisionModel: boolean, candidates: { id, label }[] }`
- Produces: `{ engine: 'auto' | 'off' | 'local' | string, local?: { baseURL, model } }`

- [ ] **Step 1: Write the failing test**

```js
test('visionSetupChoice maps numbers to engine values', () => {
  const candidates = [{ id: 'opencode-go/minimax-m3', label: 'opencode-go/minimax-m3' }];
  assert.deepEqual(visionSetupChoice('1', { candidates }), { engine: 'auto' });
  assert.deepEqual(visionSetupChoice('2', { candidates }), { engine: 'opencode-go/minimax-m3' });
  assert.deepEqual(visionSetupChoice('off', { candidates }), { engine: 'off' });
  assert.deepEqual(visionSetupChoice('', { candidates }), { engine: 'auto' });
});
```

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `visionSetupChoice` + `renderVisionChoices`**
- [ ] **Step 4: Tests pass**
- [ ] **Step 5: Commit**

```bash
git add src/setup-ui.js test/setup-ui.test.js
git commit -m "feat: vision-bridge chooser helpers for setup"
```

### Task 2: Wire into cmdSetup

**Files:**
- Modify: `src/cli.js`

After keys are stored and `saveConfig` is *not* yet called:

1. `const engine = autoVisionEngine(cfg)`
2. Print `renderVisionChoices`
3. If user picks local, `ask` for `--base-url` (default `http://127.0.0.1:1234/v1`) and `--model`
4. `assertSafeBaseURL` before writing `cfg.visionBridge`
5. Then existing save + deployment prompt

- [ ] **Step 1: Implement the step**
- [ ] **Step 2: `npm test`**
- [ ] **Step 3: Commit**

```bash
git add src/cli.js
git commit -m "feat: ask for a vision engine during setup"
```
