import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { homeDir, configPath, loadConfig, saveConfig, defaultConfig, DEFAULT_PORT, bindHost, pidPath, clearPidfile, isNpxCachePath } from './config.js';
import { REGISTRY, listProviders, catalog, resolveKey, providerEntry, assertSafeBaseURL, setupEntries, applyProviderSelection } from './providers.js';
import { startServer, resolveVisionEngine } from './server.js';
import { runSelftest } from './selftest.js';
import { patchZcodeConfig } from './zcode-config.js';
import { describeServiceTarget, installService, serviceStatus, startService, stopService, uninstallService, localDir } from './service.js';
import { dockerDown, dockerStatus, installDocker } from './docker.js';
import { pickProviders } from './setup-ui.js';
import { applyDoctorFixes, collectDoctorChecks, formatDoctorReport } from './doctor.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const runningFromNpxCache = isNpxCachePath(fileURLToPath(import.meta.url));

const log = (...a) => console.log(...a);
const err = (...a) => console.error(...a);

export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'setup': return cmdSetup(rest);
    case 'start': return cmdStart(rest);
    case 'service': return cmdService(rest);
    case 'docker': return cmdDocker(rest);
    case 'doctor': return cmdDoctor(rest);
    case 'selftest': return cmdSelftest();
    case 'providers': return cmdProviders(rest);
    case 'models': return cmdModels(rest);
    case 'vision-bridge': return cmdVisionBridge(rest);
    case 'zcode-patch': return cmdZcodePatch(rest);
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
  setup                          Guided setup: pick providers, keys, then background runner
                                 (service and docker copy the router to a permanent location;
                                 manual mode needs a permanent install, not an npx cache)
  start [--port N] [--verbose]   Run the router on 127.0.0.1 (default port ${DEFAULT_PORT})
  service install|uninstall|status|start|stop
                                 Native background runner (Task Scheduler .vbs / systemd / launchd),
                                 runs from a self-contained copy in ${localDir()}
  docker [up|down|status]        Docker Compose (restart: unless-stopped). Default: up
  doctor [--probe] [--json] [--fix]
                                 Verify config and print the exact zCode settings
                                 (--probe hits GET /models, --fix restores 0600 + zCode image patch)
  selftest                       Full end-to-end check against a mock provider (no API key needed)

Providers & models:
  providers                      List providers (enabled, key source, models)
  providers enable|disable <id>  Toggle a provider (run \`providers\` for the full list)
  providers key <id> set|clear   Store/remove a provider API key (hidden prompt)
  providers add-custom <id> --base-url URL --models a,b,c [--vision b] [--messages d]
  providers remove-custom <id>
  models                         List the catalog zCode will see
  models vision <p/m> on|off     Override a model's image support flag
  models add <p/m> [--vision] [--protocol messages]
                                 List a model that is not in the registry (new upstream
                                 models route through enabled providers anyway)
  models remove <p/m>            Remove a model added with \`models add\`

Vision bridge (images -> vision model -> text evidence for text-only models):
  vision-bridge                  Status
  vision-bridge on|off
  vision-bridge engine auto|<provider/model>
  vision-bridge engine local --base-url http://127.0.0.1:1234/v1 --model qwen2.5vl:3b

Maintenance:
  zcode-patch                    Patch ~/.zcode/v2/config.json so zCode allows image attachments
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
    const entries = setupEntries(cfg);
    const alreadyOn = new Set();
    entries.forEach((p, i) => {
      if (p.enabled) alreadyOn.add(i + 1);
    });
    log('Choose every API to load. Numbers toggle [x]/[ ]; comma-separated is fine.');
    log('Empty Enter continues to keys, then how to keep the router running.');
    const chosen = await pickProviders({
      entries,
      selectedPositions: alreadyOn,
      prompt: ask,
      write: (s) => process.stdout.write(s),
    });
    cfg.providers = applyProviderSelection(cfg, chosen).providers;
    for (const id of chosen) {
      const entry = providerEntry(cfg, id);
      if (entry.note) log(`  ${id}: ${entry.note}`);
      const envKey = resolveKey(entry, cfg);
      if (envKey.key) {
        log(`  ${id}: key found (${envKey.source})`);
      } else {
        const key = await hiddenPrompt(`  API key for ${id} (input hidden, empty = skip): `);
        if (key) cfg.providers[id].key = key;
      }
    }
    const engine = cfg.visionBridge?.engine;
    if (engine && engine !== 'auto' && engine !== 'local' && !chosen.includes(engine.split('/')[0])) {
      cfg.visionBridge = { ...(cfg.visionBridge || {}), engine: 'auto' };
    }
    saveConfig(cfg);
    log(`\nConfig written to ${configPath()} (mode 0600${process.platform === 'win32' ? ' + user-only ACL' : ''}).`);
    printZCodeBlock(cfg);
    log('\nKeep the router running so ZCode can always reach it?');
    log(`  1) Native background service — ${describeServiceTarget()}`);
    log('  2) Docker (compose, restart: unless-stopped; ZCode still uses http://127.0.0.1)');
    log('  3) Manual — I will run `zcode-router start` myself');
    if (runningFromNpxCache) {
      log('     (unavailable here: npx runs from a temporary cache — manual mode needs a permanent install, see below)');
    }
    let mode = (await ask('Choice [1]: ')).trim() || '1';
    while (runningFromNpxCache && mode !== '1' && mode !== '2') {
      log('\nManual mode cannot run from `npx`: npx downloaded this package into a temporary cache');
      log('that gets cleaned up, so `zcode-router start` would silently stop working later.');
      log('To use manual mode, install a permanent copy first (npm install -g zcode-router),');
      log('then run `zcode-router setup` again — or pick 1 (service) or 2 (docker) here:');
      log('both copy the router out of the npx cache and keep working on their own.');
      mode = (await ask('Choice [1]: ')).trim() || '1';
    }
    if (mode === '1') {
      try {
        installService();
        log(`Background service installed. ${describeServiceTarget()}`);
        log(`It runs from a self-contained copy in ${localDir()} — independent of npm/npx caches.`);
        log('Stop later with `zcode-router service stop` (or uninstall). Re-run `zcode-router service install` after `zcode-router update`.');
      } catch (e) {
        err(`Could not install background service: ${e.message}`);
        log('Start manually with `zcode-router start`, or retry `zcode-router service install`.');
      }
    } else if (mode === '2') {
      try {
        const info = installDocker();
        log(`Docker container up (restart: unless-stopped) on http://127.0.0.1:${info.port}/v1`);
        log('Stop later with `zcode-router docker down`. Re-run `zcode-router docker` after `zcode-router update`.');
      } catch (e) {
        err(`Could not start Docker: ${e.message}`);
        log('Start manually with `zcode-router start`, or retry `zcode-router docker`.');
      }
    } else {
      log('\nNext: run `zcode-router selftest` (no API key needed), then `zcode-router start`.');
    }
  } finally {
    rl.close();
  }
}

// ---------- start ----------

async function cmdStart(args) {
  if (runningFromNpxCache) {
    err('\nwarning: you are running from a temporary `npx` cache — npm may delete these files');
    err('while the router is still serving. Prefer `zcode-router setup` and pick a background');
    err('runner (service/docker), or install a permanent copy with `npm install -g zcode-router`.\n');
  }
  const cfg = loadConfig();
  if (!cfg) {
    err(`No config at ${configPath()} yet. Run \`zcode-router setup\` first.`);
    process.exitCode = 1;
    return;
  }
  const verbose = args.includes('--verbose') || process.env.ZCODE_ROUTER_VERBOSE === '1';
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
  const host = bindHost();
  const server = await startServer({ config: cfg, log: (m) => err(`[router] ${m}`), verbose });
  try {
    fs.writeFileSync(pidPath(), String(process.pid));
  } catch {
    /* pidfile is best-effort for `service stop` */
  }
  const where =
    host === '0.0.0.0'
      ? `http://0.0.0.0:${cfg.port} (all interfaces — Docker; publish only 127.0.0.1 on the host)`
      : `http://127.0.0.1:${cfg.port} (loopback only)`;
  log(`zcode-router ${VERSION} listening on ${where}${verbose ? ' [verbose]' : ''}`);
  printZCodeBlock(cfg);
  log('\nModels served (copy-paste into zCode if the list does not auto-load):');
  const engine = resolveVisionEngine(cfg);
  for (const m of catalog(cfg)) {
    const tag = m.vision ? '[vision]' : engine ? '[text-only, vision-bridged]' : '[text-only]';
    log(`  ${m.id}  ${tag}`);
  }
  log(`Vision bridge: ${cfg.visionBridge?.enabled === false ? 'off' : engine ? `on, engine ${engine.label}` : 'on, but no vision engine available (images stay refused)'}`);
  if (engine) {
    log('zCode caches model capabilities: click Refresh on the provider, fully quit zCode, and start a new chat so it re-reads image support.');
    reportZcodePatch(patchZcodeConfig({ port: cfg.port }));
  }
  if (process.stdout.isTTY) log('Ctrl+C to stop. Keep this running while you use ZCode.');
  if (verbose) log('Verbose logging on — request headers, message text (redacted), and vision-bridge steps will be printed.');
  checkForUpdate(cfg).catch(() => {});
  const shutdown = () => {
    clearPidfile();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cmdService(rest) {
  const [sub] = rest;
  switch (sub) {
    case 'install':
      if (!loadConfig()) return noConfig();
      try {
        installService();
        log(`Installed. ${describeServiceTarget()}`);
        log(`Runs from a self-contained copy in ${localDir()} — re-run \`zcode-router service install\` after \`zcode-router update\` to refresh it.`);
      } catch (e) {
        err(e.message);
        process.exitCode = 1;
      }
      return;
    case 'uninstall':
      try {
        uninstallService();
        log('Background service removed.');
      } catch (e) {
        err(e.message);
        process.exitCode = 1;
      }
      return;
    case 'status': {
      const st = serviceStatus();
      log(st.installed ? st.detail || 'installed' : 'not installed');
      if (!st.installed) process.exitCode = 1;
      return;
    }
    case 'start':
      try {
        startService();
        log('Started.');
      } catch (e) {
        err(e.message);
        process.exitCode = 1;
      }
      return;
    case 'stop':
      stopService();
      log('Stopped.');
      return;
    default:
      err('Usage: zcode-router service install|uninstall|status|start|stop');
      process.exitCode = 1;
  }
}

function cmdDocker(rest) {
  const [sub] = rest;
  switch (sub) {
    case undefined:
    case 'up':
      if (!loadConfig()) return noConfig();
      try {
        const info = installDocker();
        log(`Docker up (restart: unless-stopped) on http://127.0.0.1:${info.port}/v1`);
      } catch (e) {
        err(e.message);
        process.exitCode = 1;
      }
      return;
    case 'down':
      try {
        dockerDown();
        log('Docker container stopped.');
      } catch (e) {
        err(e.message);
        process.exitCode = 1;
      }
      return;
    case 'status': {
      const st = dockerStatus();
      log(st.installed ? st.detail || 'installed' : 'not installed');
      if (!st.installed) process.exitCode = 1;
      return;
    }
    default:
      err('Usage: zcode-router docker [up|down|status]');
      process.exitCode = 1;
  }
}

function reportZcodePatch(result) {
  if (!result.ok && result.reason === 'no-config') {
    log(`zCode config not found at ${result.path} — skip (ok if zCode is not installed here).`);
    return;
  }
  if (!result.ok) {
    err(`zCode config patch skipped: ${result.reason} (${result.path})`);
    return;
  }
  if (result.patched === 0) {
    log(`zCode config: no router provider to patch in ${result.path}`);
    return;
  }
  log(`zCode config: set image input on ${result.patched} model(s) in ${result.names.join(', ')}.`);
  log(`Backup: ${result.backup}`);
  log('Fully quit zCode and start a new chat for the patch to apply.');
}

function cmdZcodePatch() {
  const cfg = loadConfig() || defaultConfig();
  const result = patchZcodeConfig({ port: cfg.port });
  reportZcodePatch(result);
  if (!result.ok && result.reason !== 'no-config') process.exitCode = 1;
}

function printZCodeBlock(cfg) {
  log(`
ZCode setup (Settings → Model Settings → Add Provider):
  Name:     zcode-router
  Base URL: http://127.0.0.1:${cfg.port}/v1
  API Key:  ${cfg.localKey}
zCode will fetch the model list automatically. The key is loopback-only — do not share it.
After changing the router, click Refresh on this provider and start a new chat — zCode caches whether a model accepts images.`);
}

// ---------- doctor ----------

async function cmdDoctor(args) {
  const probe = args.includes('--probe');
  const asJson = args.includes('--json');
  const fix = args.includes('--fix');
  if (fix) {
    const repaired = applyDoctorFixes();
    for (const item of repaired.fixed) log(`fix  ${item}`);
    for (const item of repaired.errors) err(`fix  ${item}`);
  }
  const result = await collectDoctorChecks({ probe });
  if (asJson) {
    log(JSON.stringify({ checks: result.checks, failed: result.failed }, null, 2));
  } else {
    log(formatDoctorReport(result));
  }
  if (result.failed > 0) process.exitCode = 1;
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
    const listed = loadConfig() || defaultConfig();
    const width = Math.max(14, ...listProviders(listed).map((p) => p.id.length));
    for (const p of listProviders(listed)) {
      const { key, source } = resolveKey(p, listed);
      log(`${p.enabled ? 'SHOW' : 'hide'}  ${p.id.padEnd(width)} ${p.label}  key:${key ? source : 'none'}  models:${p.models.length}`);
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
    const messagesProtocol = new Set((flag(tail, '--messages') || '').split(',').map((s) => s.trim()).filter(Boolean));
    if (!id || !baseURL || models.length === 0) {
      err('Usage: providers add-custom <id> --base-url URL --models a,b,c [--vision b] [--messages d]');
      process.exitCode = 1;
      return;
    }
    assertSafeBaseURL(baseURL);
    cfg.providers[id] = {
      ...(cfg.providers[id] || {}),
      enabled: true,
      baseURL,
      models: models.map((m) => ({ id: m, vision: vision.has(m), protocol: messagesProtocol.has(m) ? 'messages' : 'openai' })),
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
  if (sub === 'add' || sub === 'remove') {
    if (!cfg) return noConfig();
    const slash = target?.indexOf('/') ?? -1;
    if (slash <= 0) {
      err(`Usage: models ${sub} <provider/model>${sub === 'add' ? ' [--vision] [--protocol messages]' : ''}`);
      process.exitCode = 1;
      return;
    }
    const pid = target.slice(0, slash);
    const mid = target.slice(slash + 1);
    const entry = providerEntry(cfg, pid);
    if (!entry) return unknownProvider(target);
    cfg.providers[pid] = cfg.providers[pid] || {};
    if (sub === 'add') {
      const spec = { id: mid, vision: rest.includes('--vision'), protocol: flag(rest, '--protocol') === 'messages' ? 'messages' : 'openai' };
      const extra = cfg.providers[pid].extra || [];
      const existing = extra.findIndex((m) => (typeof m === 'string' ? m : m.id) === mid);
      if (existing === -1) extra.push(spec);
      else extra[existing] = spec;
      cfg.providers[pid].extra = extra;
      saveConfig(cfg);
      log(`${target} added (${spec.protocol}${spec.vision ? ', vision' : ''}) — appears in zCode after Refresh.`);
      return;
    }
    const extra = cfg.providers[pid].extra || [];
    const idx = extra.findIndex((m) => (typeof m === 'string' ? m : m.id) === mid);
    if (idx === -1) {
      err(`${target} is not an added model (registry models cannot be removed).`);
      process.exitCode = 1;
      return;
    }
    extra.splice(idx, 1);
    cfg.providers[pid].extra = extra;
    saveConfig(cfg);
    log(`${target} removed.`);
    return;
  }
  if (!cfg) return noConfig();
  const items = catalog(cfg);
  if (items.length === 0) {
    log('(no routable models — run `zcode-router setup`)');
    return;
  }
  const engine = resolveVisionEngine(cfg);
  for (const m of items) {
    const tag = m.vision ? '[vision]' : engine ? '[text-only, vision-bridged]' : '[text-only]';
    log(`${m.id}  ${tag}`);
  }
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
    if (code === 0) {
      log('Updated. If you use a background runner, refresh it so it picks up the new files:');
      log('  zcode-router service install   (or:  zcode-router docker)');
      log('Otherwise just restart `zcode-router start`.');
    }
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
