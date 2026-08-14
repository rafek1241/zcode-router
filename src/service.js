import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, killFromPidfile, loadConfig } from './config.js';

export const TASK_NAME = 'zcode-router';
export const LINUX_UNIT = 'zcode-router.service';
export const DARWIN_LABEL = 'com.zcode-router';

const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function startCmdPath() {
  return join(homeDir(), 'start.cmd');
}

function startVbsPath() {
  return join(homeDir(), 'start.vbs');
}

function linuxUnitPath() {
  return join(homedir(), '.config', 'systemd', 'user', LINUX_UNIT);
}

function darwinPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${DARWIN_LABEL}.plist`);
}

// Self-contained copy of the package (bin + src) in the state dir. The
// service runs from here, so it survives npm cache cleanups, `npx` cache
// eviction, and global re-installs — like the Docker image, it no longer
// depends on where the package was downloaded from.
export function localDir() {
  return join(homeDir(), 'local');
}

export function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const src = join(from, ent.name);
    const dest = join(to, ent.name);
    if (ent.isDirectory()) copyTree(src, dest);
    else copyFileSync(src, dest);
  }
}

export function snapshotLocalPackage() {
  const dir = localDir();
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(pkgRoot, 'package.json'), join(dir, 'package.json'));
  copyTree(join(pkgRoot, 'bin'), join(dir, 'bin'));
  copyTree(join(pkgRoot, 'src'), join(dir, 'src'));
  return dir;
}

function quoteWin(p) {
  return `"${p.replaceAll('/', '\\')}"`;
}

function xmlEscape(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function windowsScripts({ node, script, home, cmdPath }) {
  const cmd = [
    '@echo off',
    `set "ZCODE_ROUTER_HOME=${home}"`,
    `cd /d ${quoteWin(home)}`,
    `${quoteWin(node)} ${quoteWin(script)} start >> ${quoteWin(join(home, 'router.log'))} 2>&1`,
    '',
  ].join('\r\n');
  // Window style 0 = hidden; Wait=True so Task Scheduler keeps the task Running
  // (ONLOGON will not spawn a second copy) and `schtasks /End` has a process to kill.
  const vbs = [
    'Set sh = CreateObject("Wscript.Shell")',
    `sh.Run """${cmdPath.replaceAll('/', '\\')}""", 0, True`,
    '',
  ].join('\r\n');
  return { cmd, vbs };
}

export function linuxUnitText({ node, script, home }) {
  return [
    '[Unit]',
    'Description=zcode-router local OpenAI-compatible proxy',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=ZCODE_ROUTER_HOME=${home}`,
    `ExecStart="${node}" "${script}" start`,
    `WorkingDirectory=${home}`,
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function darwinPlistText({ node, script, home }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${DARWIN_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(node)}</string>`,
    `    <string>${xmlEscape(script)}</string>`,
    '    <string>start</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>ZCODE_ROUTER_HOME</key>',
    `    <string>${xmlEscape(home)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(home)}</string>`,
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(join(home, 'launchd.out.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(join(home, 'launchd.err.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error,
  };
}

function failText(r, fallback) {
  return (r.stderr || r.stdout || r.error?.message || fallback).trim();
}

export function installService() {
  mkdirSync(homeDir(), { recursive: true });
  const node = process.execPath;
  const home = homeDir();
  const entry = join(snapshotLocalPackage(), 'bin', 'zcode-router.js');
  if (process.platform === 'win32') {
    const { cmd, vbs } = windowsScripts({ node, script: entry, home, cmdPath: startCmdPath() });
    writeFileSync(startCmdPath(), cmd);
    writeFileSync(startVbsPath(), vbs);
    const created = run('schtasks', [
      '/Create',
      '/TN',
      TASK_NAME,
      '/TR',
      `wscript.exe //nologo ${quoteWin(startVbsPath())}`,
      '/SC',
      'ONLOGON',
      '/RL',
      'LIMITED',
      '/F',
    ]);
    if (!created.ok) throw new Error(`schtasks failed (${created.status}): ${failText(created, 'unknown error')}`);
    run('schtasks', ['/Run', '/TN', TASK_NAME]);
    return { kind: 'windows-task', name: TASK_NAME, vbs: startVbsPath() };
  }
  if (process.platform === 'linux') {
    mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(linuxUnitPath(), linuxUnitText({ node, script: entry, home }));
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    if (!reload.ok) throw new Error(`systemctl daemon-reload failed: ${failText(reload, 'unknown error')}`);
    const enable = run('systemctl', ['--user', 'enable', '--now', LINUX_UNIT]);
    if (!enable.ok) throw new Error(`systemctl enable failed: ${failText(enable, 'unknown error')}`);
    return { kind: 'systemd-user', unit: LINUX_UNIT };
  }
  if (process.platform === 'darwin') {
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(darwinPlistPath(), darwinPlistText({ node, script: entry, home }));
    const uid = process.getuid?.() ?? 501;
    let boot = run('launchctl', ['bootstrap', `gui/${uid}`, darwinPlistPath()]);
    if (!boot.ok) boot = run('launchctl', ['load', '-w', darwinPlistPath()]);
    run('launchctl', ['enable', `gui/${uid}/${DARWIN_LABEL}`]);
    run('launchctl', ['kickstart', '-k', `gui/${uid}/${DARWIN_LABEL}`]);
    return { kind: 'launchd', label: DARWIN_LABEL, plist: darwinPlistPath() };
  }
  throw new Error(`No background service for ${process.platform}. Use: zcode-router docker`);
}

export function uninstallService() {
  stopService();
  if (process.platform === 'win32') {
    run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    for (const p of [startCmdPath(), startVbsPath()]) {
      try {
        unlinkSync(p);
      } catch {
        /* missing is fine */
      }
    }
    return { kind: 'windows-task', name: TASK_NAME };
  }
  if (process.platform === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', LINUX_UNIT]);
    try {
      unlinkSync(linuxUnitPath());
    } catch {
      /* missing is fine */
    }
    run('systemctl', ['--user', 'daemon-reload']);
    return { kind: 'systemd-user', unit: LINUX_UNIT };
  }
  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    run('launchctl', ['bootout', `gui/${uid}/${DARWIN_LABEL}`]);
    run('launchctl', ['unload', darwinPlistPath()]);
    try {
      unlinkSync(darwinPlistPath());
    } catch {
      /* missing is fine */
    }
    return { kind: 'launchd', label: DARWIN_LABEL };
  }
  throw new Error(`No background service for ${process.platform}`);
}

export function serviceStatus() {
  if (process.platform === 'win32') {
    const r = run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V']);
    return { installed: r.ok, detail: (r.stdout || r.stderr).trim() };
  }
  if (process.platform === 'linux') {
    if (!existsSync(linuxUnitPath())) return { installed: false, detail: 'not installed' };
    const r = run('systemctl', ['--user', 'status', LINUX_UNIT, '--no-pager']);
    return { installed: true, detail: (r.stdout || r.stderr).trim() };
  }
  if (process.platform === 'darwin') {
    if (!existsSync(darwinPlistPath())) return { installed: false, detail: 'not installed' };
    const r = run('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${DARWIN_LABEL}`]);
    return { installed: true, detail: (r.stdout || r.stderr).trim() };
  }
  return { installed: false, detail: `unsupported platform ${process.platform}` };
}

export function startService() {
  if (process.platform === 'win32') {
    const r = run('schtasks', ['/Run', '/TN', TASK_NAME]);
    if (!r.ok) throw new Error(failText(r, 'schtasks /Run failed'));
    return;
  }
  if (process.platform === 'linux') {
    const r = run('systemctl', ['--user', 'start', LINUX_UNIT]);
    if (!r.ok) throw new Error(failText(r, 'systemctl start failed'));
    return;
  }
  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    const r = run('launchctl', ['kickstart', '-k', `gui/${uid}/${DARWIN_LABEL}`]);
    if (!r.ok) throw new Error(failText(r, 'launchctl kickstart failed'));
    return;
  }
  throw new Error(`No background service for ${process.platform}`);
}

export function stopService() {
  killFromPidfile();
  if (process.platform === 'win32') {
    run('schtasks', ['/End', '/TN', TASK_NAME]);
    return;
  }
  if (process.platform === 'linux') {
    run('systemctl', ['--user', 'stop', LINUX_UNIT]);
    return;
  }
  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    run('launchctl', ['kill', 'SIGTERM', `gui/${uid}/${DARWIN_LABEL}`]);
  }
}

export function describeServiceTarget() {
  const port = loadConfig()?.port ?? 4279;
  if (process.platform === 'win32') {
    return `Windows Task Scheduler "${TASK_NAME}" (hidden .vbs, ONLOGON) → http://127.0.0.1:${port}/v1`;
  }
  if (process.platform === 'linux') {
    return `systemd --user ${LINUX_UNIT} → http://127.0.0.1:${port}/v1`;
  }
  if (process.platform === 'darwin') {
    return `launchd ${DARWIN_LABEL} → http://127.0.0.1:${port}/v1`;
  }
  return `unsupported (${process.platform})`;
}
