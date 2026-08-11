import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homeDir, configPath, loadConfig, saveConfig, defaultConfig, DEFAULT_PORT } from './config.js';
import { REGISTRY, listProviders, catalog, resolveKey, providerEntry, assertSafeBaseURL, isLoopback } from './providers.js';
import { startServer, resolveVisionEngine } from './server.js';
import { runSelftest } from './selftest.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const log = (...a) => console.log(...a);
const err = (...a) => console.error(...a);

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'setup': return cmdSetup(rest);
    case 'start': return cmdStart(rest);
    case 'doctor': return cmdDoctor(rest);
    case 'selftest': return cmdSelftest();
    case 'providers': return cmdProviders(rest);
    case 'models': return cmdModels(rest);
    case 'vision-bridge': return cmdVisionBridge(rest);
    case 'update': return cmdUpdate();
    case 'version':
    case '--version':
    case '-v': return log(VERSION);
    case 'help':
    case '--help':
    case '-h':
    case undefined: return printHelp();
    default:
      err(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp() {
  log(`zcode-router ${VERSION} — local model router for ZCode with a vision bridge

Usage: zcode-router <command>

Getting started:
  setup                          Guided setup: pick providers, store keys (hidden prompt)
  start [--port N]               Run the router on 127.0.0.1 (default port ${DEFAULT_PORT})
  doctor [--probe]               Verify config and print the exact zCode settings
  selftest                       Full end-to-end check against a mock provider (no API key needed)

Providers & models:
  providers                      List providers (enabled, key source, models)
  providers enable|disable <id>  Toggle a provider (${Object.keys(REGISTRY).join(', ')})
  providers key <id> set|clear   Store/remove a provider API key (hidden prompt)
  providers add-custom <id> --base-url URL --models a,b,c [--vision b]
  providers remove-custom <id>
  models                         List the catalog zCode will see
  models vision <p/m> on|off     Override a model's image support flag

Vision bridge (images -> vision model -> text evidence for text-only models):
  vision-bridge                  Status
  vision-bridge on|off
  vision-bridge engine auto|<provider/model>
  vision-bridge engine local --base-url http://127.0.0.1:1234/v1 --model qwen2.5vl:3b

Maintenance:
  update                         Update the global npm package
  version                        Print version

State directory: ${homeDir()} (override with ZCODE_ROUTER_HOME)`);
}

// ---------- setup ----------

async function cmdSetup() {
  if (!process.stdin.isTTY) {
    err('setup is interactive. Use `providers key <id> set` / `providers enable <id>` for scripts.');
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig() || defaultConfig();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  try {
    log('Available providers:');
    const entries = listProviders(cfg);
    entries.forEach((p, i) => {
      const state = p.enabled ? 'enabled' : 'disabled';
      log(`  ${i + 1}. ${p.id} — ${p.label} [${state}]`);
    });
    const pick = await ask('\nEnable which? (numbers or ids, comma-separated, empty = keep current): ');
    const chosen = pick.split(',').map((s) => s.trim()).filter(Boolean);
    for (const c of chosen) {
      const entry = entries[Number(c) - 1] || providerEntry(cfg, c);
      if (!entry) {
        err(`  skipping unknown provider "${c}"`);
        continue;
      }
      cfg.providers[entry.id] = { ...(cfg.providers[entry.id] || {}), enabled: true };
      const envKey = resolveKey(providerEntry(cfg, entry.id));
      if (envKey.key) {
        log(`  ${entry.id}: key found (${envKey.source})`);
      } else {
        const key = await hiddenPrompt(`  API key for ${entry.id} (input hidden, empty = skip): `);
        if (key) cfg.providers[entry.id].key = key;
      }
    }
    saveConfig(cfg);
    log(`\nConfig written to ${configPath()} (mode 0600${process.platform === 'win32' ? ' + user-only ACL' : ''}).`);
    printZCodeBlock(cfg);
    log('\nNext: run `zcode-router selftest` (no API key needed), then `zcode-router start`.');
  } finally {
    rl.close();
  }
}

// ---------- start ----------

async function cmdStart(args) {
  const cfg = loadConfig();
  if (!cfg) {
    err(`No config at ${configPath()} yet. Run \`zcode-router setup\` first.`);
    process.exitCode = 1;
    return;
  }
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1) {
    const p = Number(args[portIdx + 1]);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      err('--port must be an integer 1-65535');
      process.exitCode = 1;
      return;
    }
    cfg.port = p;
  }
  for (const p of listProviders(cfg)) {
    if (p.enabled) {
      try {
        assertSafeBaseURL(p.baseURL);
      } catch (e) {
        err(e.message);
        process.exitCode = 1;
        return;
      }
    }
  }
  if (cfg.visionBridge?.engine === 'local') {
    try {
      assertSafeBaseURL(cfg.visionBridge.local?.baseURL || '');
    } catch (e) {
      err(`vision bridge: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }
  if (catalog(cfg).length === 0) {
    err('No routable models: enable a provider and store its key first (`zcode-router setup`).');
    process.exitCode = 1;
    return;
  }
  const server = await startServer({ config: cfg, log: (m) => err(`[router] ${m}`) });
  log(`zcode-router ${VERSION} listening on http://127.0.0.1:${cfg.port} (loopback only)`);
  printZCodeBlock(cfg);
  const engine = resolveVisionEngine(cfg);
  log(`Vision bridge: ${cfg.visionBridge?.enabled === false ? 'off' : engine ? `on, engine ${engine.label}` : 'on, but no vision engine available (images stay refused)'}`);
  log('Ctrl+C to stop. Keep this running while you use ZCode.');
  checkForUpdate(cfg).catch(() => {});
  process.on('SIGINT', () => { server.close(); process.exit(0); });
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
}

function printZCodeBlock(cfg) {
  log(`
ZCode setup (Settings → Model Settings → Add Provider):
  Name:     zcode-router
  Base URL: http://127.0.0.1:${cfg.port}/v1
  API Key:  ${cfg.localKey}
zCode will fetch the model list automatically. The key is loopback-only — do not share it.`);
}

// ---------- doctor ----------

async function cmdDoctor(args) {
  let fail = 0;
  const ok = (name, pass, detail = '') => {
    if (!pass) fail += 1;
    log(`${pass ? ' OK ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  };

  let cfg = null;
  try {
    cfg = loadConfig();
    ok('config file', Boolean(cfg), configPath());
  } catch (e) {
    ok('config file', false, `${configPath()}: ${e.message}`);
    return finish();
  }
  if (!cfg) return finish();

  if (process.platform !== 'win32') {
    const mode = fs.statSync(configPath()).mode & 0o777;
    ok('config permissions', mode === 0o600, `mode ${mode.toString(8)}`);
  }

  ok('local key present', typeof cfg.localKey === 'string' && cfg.localKey.length >= 16);

  const port = cfg.port || DEFAULT_PORT;
  const running = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (running) {
    ok('router process', true, `127.0.0.1:${port} responding`);
  } else {
    const portFree = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    ok('port available', portFree, `127.0.0.1:${port} ${portFree ? 'free' : 'in use by another process'}`);
  }

  const models = catalog(cfg);
  ok('routable models', models.length > 0, models.length ? `${models.length} model(s)` : 'none — run setup');

  for (const p of listProviders(cfg)) {
    if (!p.enabled) continue;
    const { key, source } = resolveKey(p);
    const keyless = isLoopback(p.baseURL);
    ok(`provider ${p.id}`, Boolean(key) || keyless, key ? `key from ${source}` : keyless ? 'loopback, no key needed' : 'NO KEY');
    if (args.includes('--probe') && key) {
      try {
        assertSafeBaseURL(p.baseURL);
        const r = await fetch(`${p.baseURL.replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        ok(`provider ${p.id} probe`, r.ok, `GET /models -> HTTP ${r.status} (free call)`);
      } catch (e) {
        ok(`provider ${p.id} probe`, false, e.message);
      }
    }
  }

  const vb = cfg.visionBridge;
  if (vb?.enabled === false) {
    log('INFO  vision bridge disabled — images to text-only models will be refused by the provider');
  } else {
    const engine = resolveVisionEngine(cfg);
    // No engine is not a failure: the bridge just stays inactive, as without the router.
    log(`INFO  vision bridge engine: ${engine ? engine.label : 'none available — pin one with \`vision-bridge engine <provider/model>\` to enable image pasting'}`);
  }

  finish();

  function finish() {
    if (fail > 0) {
      err(`\n${fail} check(s) failed.`);
      process.exitCode = 1;
    } else if (cfg) {
      printZCodeBlock(cfg);
    }
  }
}

// ---------- selftest ----------

async function cmdSelftest() {
  log('Selftest uses a mock in-process provider on 127.0.0.1 — no real provider, account, or network needed.\n');
  const passed = await runSelftest(log);
  if (!passed) process.exitCode = 1;
}

// ---------- providers / models ----------

async function cmdProviders(rest) {
  const [sub, id, ...tail] = rest;
  if (!sub || sub === 'list') {
    for (const p of listProviders(loadConfig() || defaultConfig())) {
      const { key, source } = resolveKey(p);
      log(`${p.enabled ? 'SHOW' : 'hide'}  ${p.id.padEnd(14)} ${p.label}  key:${key ? source : 'none'}  models:${p.models.length}`);
    }
    return;
  }
  const cfg = loadConfig() || defaultConfig();

  if (sub === 'enable' || sub === 'disable') {
    const entry = providerEntry(cfg, id);
    if (!entry) return unknownProvider(id);
    cfg.providers[id] = { ...(cfg.providers[id] || {}), enabled: sub === 'enable' };
    saveConfig(cfg);
    log(`${id} ${sub}d.`);
    return;
  }

  if (sub === 'key') {
    const entry = providerEntry(cfg, id);
    if (!entry) return unknownProvider(id);
    const action = tail[0] || 'set';
    cfg.providers[id] = cfg.providers[id] || {};
    if (action === 'set') {
      const key = await hiddenPrompt(`API key for ${id} (input hidden): `);
      if (!key) {
        err('empty key — unchanged');
        process.exitCode = 1;
        return;
      }
      cfg.providers[id].key = key;
      saveConfig(cfg);
      log(`Key for ${id} stored in ${configPath()}.`);
    } else if (action === 'clear') {
      delete cfg.providers[id].key;
      saveConfig(cfg);
      log(`Key for ${id} removed.`);
    }
    return;
  }

  if (sub === 'add-custom') {
    const baseURL = flag(tail, '--base-url');
    const models = (flag(tail, '--models') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const vision = new Set((flag(tail, '--vision') || '').split(',').map((s) => s.trim()).filter(Boolean));
    if (!id || !baseURL || models.length === 0) {
      err('Usage: providers add-custom <id> --base-url URL --models a,b,c [--vision b]');
      process.exitCode = 1;
      return;
    }
    assertSafeBaseURL(baseURL);
    cfg.providers[id] = {
      ...(cfg.providers[id] || {}),
      enabled: true,
      baseURL,
      models: models.map((m) => ({ id: m, vision: vision.has(m) })),
    };
    saveConfig(cfg);
    log(`Custom provider ${id} added (${models.length} models). Store its key: providers key ${id} set`);
    return;
  }

  if (sub === 'remove-custom') {
    if (!cfg.providers[id]?.baseURL || REGISTRY[id]) {
      err(`${id} is not a custom provider.`);
      process.exitCode = 1;
      return;
    }
    delete cfg.providers[id];
    saveConfig(cfg);
    log(`Custom provider ${id} removed.`);
    return;
  }

  err(`Unknown providers subcommand: ${sub}`);
  process.exitCode = 1;
}

function unknownProvider(id) {
  err(`Unknown provider "${id}". Known: ${[...Object.keys(REGISTRY)].join(', ')} (or add-custom).`);
  process.exitCode = 1;
}

function cmdModels(rest) {
  const cfg = loadConfig();
  const [sub, target, value] = rest;
  if (sub === 'vision') {
    if (!cfg) return noConfig();
    const slash = target?.indexOf('/') ?? -1;
    if (slash <= 0 || !['on', 'off'].includes(value)) {
      err('Usage: models vision <provider/model> on|off');
      process.exitCode = 1;
      return;
    }
    const pid = target.slice(0, slash);
    const mid = target.slice(slash + 1);
    const entry = providerEntry(cfg, pid);
    if (!entry || !entry.models.some((m) => m.id === mid)) return unknownProvider(target);
    cfg.providers[pid] = cfg.providers[pid] || {};
    cfg.providers[pid].overrides = { ...(cfg.providers[pid].overrides || {}), [mid]: { vision: value === 'on' } };
    saveConfig(cfg);
    log(`${target}: vision ${value}.`);
    return;
  }
  if (!cfg) return noConfig();
  const items = catalog(cfg);
  if (items.length === 0) {
    log('(no routable models — run `zcode-router setup`)');
    return;
  }
  for (const m of items) log(`${m.id}  ${m.vision ? '[vision]' : '[text-only]'}`);
}

function noConfig() {
  err(`No config at ${configPath()} yet. Run \`zcode-router setup\` first.`);
  process.exitCode = 1;
}

// ---------- vision-bridge ----------

function cmdVisionBridge(rest) {
  const cfg = loadConfig();
  if (!cfg) return noConfig();
  cfg.visionBridge = cfg.visionBridge || { enabled: true, engine: 'auto', local: null };
  const [sub, ...tail] = rest;

  if (!sub || sub === 'status') {
    const engine = resolveVisionEngine(cfg);
    log(`vision bridge: ${cfg.visionBridge.enabled === false ? 'OFF' : 'on'}`);
    log(`engine: ${engine ? engine.label : 'none available'}`);
    if (cfg.visionBridge.local) log(`local: ${cfg.visionBridge.local.model} @ ${cfg.visionBridge.local.baseURL}`);
    return;
  }
  if (sub === 'on' || sub === 'off') {
    cfg.visionBridge.enabled = sub === 'on';
    saveConfig(cfg);
    log(`vision bridge ${sub}.`);
    return;
  }
  if (sub === 'engine') {
    const target = tail[0];
    if (target === 'auto') {
      cfg.visionBridge.engine = 'auto';
    } else if (target === 'local') {
      const baseURL = flag(tail, '--base-url');
      const model = flag(tail, '--model');
      if (!baseURL || !model) {
        err('Usage: vision-bridge engine local --base-url http://127.0.0.1:1234/v1 --model qwen2.5vl:3b');
        process.exitCode = 1;
        return;
      }
      assertSafeBaseURL(baseURL);
      cfg.visionBridge.engine = 'local';
      cfg.visionBridge.local = { baseURL, model };
    } else if (target) {
      const entry = providerEntry(cfg, target.split('/')[0]);
      if (!entry) return unknownProvider(target);
      cfg.visionBridge.engine = target;
    } else {
      err('Usage: vision-bridge engine auto|<provider/model>|local ...');
      process.exitCode = 1;
      return;
    }
    saveConfig(cfg);
    log(`vision bridge engine: ${cfg.visionBridge.engine === 'local' ? `local:${cfg.visionBridge.local.model}` : cfg.visionBridge.engine}`);
    return;
  }
  err(`Unknown vision-bridge subcommand: ${sub}`);
  process.exitCode = 1;
}

// ---------- update ----------

function cmdUpdate() {
  log('Updating zcode-router via npm...');
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', 'zcode-router@latest'], { stdio: 'inherit' });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
    if (code === 0) log('Updated. Restart any running router to use the new version.');
  });
}

async function checkForUpdate(cfg) {
  const stateFile = path.join(homeDir(), 'update-check.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (Date.now() - state.checkedAt < 24 * 3600 * 1000) return;
  } catch { /* no state yet */ }
  const resp = await fetch('https://registry.npmjs.org/zcode-router/latest', { signal: AbortSignal.timeout(3000) });
  if (!resp.ok) return;
  const { version } = await resp.json();
  fs.writeFileSync(stateFile, JSON.stringify({ checkedAt: Date.now(), version }));
  if (isNewer(version, VERSION)) {
    err(`\nUpdate available: ${VERSION} -> ${version}. Run \`zcode-router update\`.\n`);
  }
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// ---------- helpers ----------

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

function hiddenPrompt(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Non-interactive: read one line without echo games (CI/scripts use env vars anyway).
      process.stdout.write(question);
      let buf = '';
      stdin.resume();
      stdin.on('data', function onData(d) {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          stdin.off('data', onData);
          stdin.pause();
          resolve(buf.slice(0, nl).trim());
        }
      });
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (d) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}
