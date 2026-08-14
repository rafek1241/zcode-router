import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProviderChoices, toggleSelection, pickProviders, visionSetupChoice, renderVisionChoices } from '../src/setup-ui.js';

const entries = [
  { id: 'opencode-go', label: 'opencode Go (subscription)', group: 'subscription', keyReady: true },
  { id: 'deepseek', label: 'DeepSeek (API)', group: 'api', keyReady: false },
  { id: 'groq', label: 'Groq (catalog)', group: 'catalog', keyReady: false },
];

test('toggleSelection does not finish on a single number — it toggles and waits', () => {
  const first = toggleSelection(new Set(), '1', 3);
  assert.equal(first.done, undefined);
  assert.deepEqual([...first.selected], [1]);

  const second = toggleSelection(first.selected, '2,3', 3);
  assert.equal(second.done, undefined);
  assert.deepEqual([...second.selected].sort(), [1, 2, 3]);

  const untoggle = toggleSelection(second.selected, '1', 3);
  assert.deepEqual([...untoggle.selected].sort(), [2, 3]);
});

test('toggleSelection empty Enter continues only after at least one pick', () => {
  const empty = toggleSelection(new Set(), '', 3);
  assert.equal(empty.done, undefined);
  assert.match(empty.error, /at least one/);

  const done = toggleSelection(new Set([2]), '  ', 3);
  assert.equal(done.done, true);
  assert.deepEqual([...done.selected], [2]);
});

test('toggleSelection a=all n=none and rejects junk', () => {
  const all = toggleSelection(new Set(), 'a', 3);
  assert.deepEqual([...all.selected].sort(), [1, 2, 3]);
  const none = toggleSelection(all.selected, 'none', 3);
  assert.equal(none.selected.size, 0);
  const bad = toggleSelection(new Set([1]), '9', 3);
  assert.match(bad.error, /Invalid choice/);
  assert.deepEqual([...bad.selected], [1]);
});

test('renderProviderChoices groups and marks the current set', () => {
  const text = renderProviderChoices(entries, new Set([1, 3]));
  assert.match(text, /Subscriptions/);
  assert.match(text, /Vendor APIs/);
  assert.match(text, /Catalog-only/);
  assert.match(text, /\[x\] 1\. opencode-go/);
  assert.match(text, /\[ \] 2\. deepseek/);
  assert.match(text, /\[x\] 3\. groq/);
});

test('pickProviders stays on the list until empty Enter, then returns every toggled id', async () => {
  const prompts = ['1', '2', ''];
  const writes = [];
  const ids = await pickProviders({
    entries,
    selectedPositions: new Set(),
    prompt: async () => prompts.shift(),
    write: (s) => writes.push(s),
  });
  assert.deepEqual(ids, ['opencode-go', 'deepseek']);
  assert.ok(writes.filter((w) => w.includes('[x] 1.')).length >= 2, 'list re-rendered after first toggle');
  assert.equal(prompts.length, 0, 'consumed the confirming empty Enter, not a later deployment prompt');
});

test('visionSetupChoice maps numbers to engine values', () => {
  const candidates = [{ id: 'opencode-go/minimax-m3', label: 'opencode-go/minimax-m3' }];
  assert.deepEqual(visionSetupChoice('1', { candidates }), { engine: 'auto' });
  assert.deepEqual(visionSetupChoice('2', { candidates }), { engine: 'opencode-go/minimax-m3' });
  assert.deepEqual(visionSetupChoice('off', { candidates }), { engine: 'off' });
  assert.deepEqual(visionSetupChoice('local', { candidates }), { engine: 'local' });
  assert.deepEqual(visionSetupChoice('', { candidates }), { engine: 'auto' });
  assert.match(visionSetupChoice('9', { candidates }).error, /Invalid/);
});

test('renderVisionChoices lists auto, candidates, off, and local', () => {
  const text = renderVisionChoices({ candidates: [{ id: 'opencode-go/minimax-m3', label: 'opencode-go/minimax-m3' }] });
  assert.match(text, /1\. auto/);
  assert.match(text, /2\. opencode-go\/minimax-m3/);
  assert.match(text, /\boff\b/);
  assert.match(text, /\blocal\b/);
});

test('pickProviders can confirm with an empty set when allowEmpty is set', async () => {
  const ids = await pickProviders({
    entries: [{ id: 'llama-3.3-70b', label: 'llama-3.3-70b', group: 'catalog' }],
    selectedPositions: new Set(),
    allowEmpty: true,
    prompt: async () => '',
    write: () => {},
  });
  assert.deepEqual(ids, []);
});
