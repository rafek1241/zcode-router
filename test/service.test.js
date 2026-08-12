import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { darwinPlistText, linuxUnitText, windowsScripts } from '../src/service.js';
import { composeYaml, dockerfileText, writeDockerFiles } from '../src/docker.js';
import { defaultConfig, saveConfig } from '../src/config.js';

test('windows .vbs is hidden and waits so Task Scheduler keeps the task running', () => {
  const { cmd, vbs } = windowsScripts({
    node: 'C:\\Program Files\\nodejs\\node.exe',
    script: 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\zcode-router\\bin\\zcode-router.js',
    home: 'C:\\Users\\x\\.zcode-router',
    cmdPath: 'C:\\Users\\x\\.zcode-router\\start.cmd',
  });
  assert.match(vbs, /Wscript\.Shell/);
  assert.match(vbs, /, 0, True/);
  assert.match(vbs, /start\.cmd/);
  assert.match(cmd, /ZCODE_ROUTER_HOME=C:\\Users\\x\\.zcode-router/);
  assert.match(cmd, /node\.exe/);
  assert.match(cmd, /zcode-router\.js" start/);
  assert.match(cmd, /router\.log/);
});

test('linux user unit restarts on failure and points at start', () => {
  const text = linuxUnitText({
    node: '/usr/bin/node',
    script: '/opt/zcode-router/bin/zcode-router.js',
    home: '/home/me/.zcode-router',
  });
  assert.match(text, /\[Service\]/);
  assert.match(text, /Restart=on-failure/);
  assert.match(text, /ExecStart="\/usr\/bin\/node" "\/opt\/zcode-router\/bin\/zcode-router\.js" start/);
  assert.match(text, /ZCODE_ROUTER_HOME=\/home\/me\/\.zcode-router/);
  assert.match(text, /WantedBy=default\.target/);
});

test('launchd plist runs at load and stays alive', () => {
  const text = darwinPlistText({
    node: '/usr/local/bin/node',
    script: '/opt/zcode-router/bin/zcode-router.js',
    home: '/Users/me/.zcode-router',
  });
  assert.match(text, /<string>com\.zcode-router<\/string>/);
  assert.match(text, /<key>RunAtLoad<\/key>/);
  assert.match(text, /<key>KeepAlive<\/key>/);
  assert.match(text, /<string>start<\/string>/);
  assert.match(text, /ZCODE_ROUTER_HOME/);
});

test('compose publishes loopback only and binds 0.0.0.0 inside the container', () => {
  const yml = composeYaml({ port: 4279, dataDir: 'C:\\Users\\x\\.zcode-router' });
  assert.match(yml, /127\.0\.0\.1:4279:4279/);
  assert.match(yml, /ZCODE_ROUTER_BIND: 0\.0\.0\.0/);
  assert.match(yml, /restart: unless-stopped/);
  assert.match(yml, /C:\/Users\/x\/\.zcode-router:\/data/);
  const df = dockerfileText();
  assert.match(df, /FROM node:22-alpine/);
  assert.match(df, /ZCODE_ROUTER_BIND=0\.0\.0\.0/);
  assert.match(df, /bin\/zcode-router\.js", "start"/);
});

test('writeDockerFiles copies the local package into ~/.zcode-router/docker', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-router-docker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.ZCODE_ROUTER_HOME = dir;
  t.after(() => delete process.env.ZCODE_ROUTER_HOME);
  saveConfig(defaultConfig());
  writeDockerFiles();
  const dock = path.join(dir, 'docker');
  assert.equal(fs.existsSync(path.join(dock, 'Dockerfile')), true);
  assert.equal(fs.existsSync(path.join(dock, 'docker-compose.yml')), true);
  assert.equal(fs.existsSync(path.join(dock, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(dock, 'bin', 'zcode-router.js')), true);
  assert.equal(fs.existsSync(path.join(dock, 'src', 'cli.js')), true);
  const yml = fs.readFileSync(path.join(dock, 'docker-compose.yml'), 'utf8');
  assert.match(yml, /127\.0\.0\.1:4279:4279/);
});
