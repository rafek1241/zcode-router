export const GROUP_LABELS = {
  subscription: 'Subscriptions',
  api: 'Vendor APIs',
  catalog: 'Catalog-only (type any model id in ZCode)',
};

export function toggleSelection(selected, input, count, { allowEmpty = false } = {}) {
  const trimmed = String(input || '').trim().toLowerCase();
  if (trimmed === '') {
    if (selected.size === 0 && !allowEmpty) {
      return { selected, error: 'Select at least one provider.' };
    }
    return { selected, done: true };
  }
  if (trimmed === 'a' || trimmed === 'all') {
    const all = new Set();
    for (let position = 1; position <= count; position += 1) all.add(position);
    return { selected: all };
  }
  if (trimmed === 'n' || trimmed === 'none') {
    return { selected: new Set() };
  }
  const next = new Set(selected);
  for (const part of trimmed.split(',')) {
    const value = Number(part.trim());
    if (!Number.isInteger(value) || value < 1 || value > count) {
      return { selected, error: `Invalid choice: ${part.trim()}` };
    }
    if (next.has(value)) next.delete(value);
    else next.add(value);
  }
  return { selected: next };
}

export function renderProviderChoices(entries, selected) {
  const lines = [];
  let lastGroup = null;
  entries.forEach((entry, index) => {
    const group = entry.group || 'api';
    if (group !== lastGroup) {
      lastGroup = group;
      lines.push(`\n${GROUP_LABELS[group] || group}:`);
    }
    const mark = selected.has(index + 1) ? '[x]' : '[ ]';
    const status = entry.keyReady ? 'key ready' : 'needs API key';
    lines.push(`  ${mark} ${index + 1}. ${entry.id} — ${entry.label} (${status})`);
  });
  return lines.join('\n');
}

export async function pickProviders({ entries, selectedPositions = new Set(), prompt, write = () => {}, allowEmpty = false }) {
  let selected = new Set(selectedPositions);
  for (;;) {
    write(`${renderProviderChoices(entries, selected)}\n`);
    const raw = await prompt('Toggle numbers (comma-separated), a=all, n=none; empty Enter continues: ');
    const result = toggleSelection(selected, raw, entries.length, { allowEmpty });
    selected = result.selected;
    if (result.error) write(`${result.error}\n`);
    else if (result.done) {
      return [...selected].sort((a, b) => a - b).map((position) => entries[position - 1].id);
    }
  }
}

export function renderVisionChoices({ candidates = [] } = {}) {
  const lines = ['How should pasted screenshots work?', '  1. auto — cheap vision model from the enabled catalog, if any (default)'];
  candidates.forEach((c, i) => {
    lines.push(`  ${i + 2}. ${c.label || c.id}`);
  });
  lines.push('  off — disable the vision bridge (text-only models refuse images)');
  lines.push('  local — LM Studio / Ollama on loopback');
  return lines.join('\n');
}

export function visionSetupChoice(raw, { candidates = [] } = {}) {
  const trimmed = String(raw || '').trim().toLowerCase();
  if (trimmed === '' || trimmed === '1') return { engine: 'auto' };
  if (trimmed === 'off') return { engine: 'off' };
  if (trimmed === 'local') return { engine: 'local' };
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 2 && n < 2 + candidates.length) {
    return { engine: candidates[n - 2].id };
  }
  return { error: 'Invalid choice' };
}
