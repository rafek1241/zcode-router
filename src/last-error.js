import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './config.js';
import { redactSecrets } from './debug.js';

const MAX_DETAIL = 1024;
const DAY_MS = 24 * 3600 * 1000;

export function lastErrorPath() {
  return path.join(homeDir(), 'last-error.json');
}

export function recordLastError({ providerId, routedId, upstreamModel, status, detail, at = Date.now() } = {}) {
  try {
    const rec = {
      providerId: providerId || null,
      routedId: routedId || null,
      upstreamModel: upstreamModel || null,
      status: status ?? null,
      detail: redactSecrets(String(detail || '')).slice(0, MAX_DETAIL),
      at,
    };
    fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lastErrorPath(), JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch {
    /* last-error is best-effort diagnostics */
  }
}

export function readLastError({ maxAgeMs = DAY_MS } = {}) {
  try {
    const rec = JSON.parse(fs.readFileSync(lastErrorPath(), 'utf8'));
    if (!rec || typeof rec !== 'object') return null;
    if (Number.isFinite(maxAgeMs) && maxAgeMs !== Infinity && Date.now() - Number(rec.at || 0) > maxAgeMs) return null;
    return rec;
  } catch {
    return null;
  }
}

export function formatLastError(rec) {
  if (!rec) return 'none';
  const when = rec.at ? new Date(rec.at).toISOString() : 'unknown time';
  return `${rec.routedId || rec.providerId || 'upstream'} HTTP ${rec.status} at ${when}\n  upstream model: ${rec.upstreamModel || '(same)'}\n  ${rec.detail || ''}`.trim();
}
