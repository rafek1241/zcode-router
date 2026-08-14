import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findZcodeCachePaths, bodyHasImage, isZcodeImageCachePath, bridgeFiles, isFilePart } from '../src/vision.js';
import { redactSecrets, looksLikeOmittedImage } from '../src/debug.js';

const unix = '/tmp/zcode-img-VKx7Fu/.zcode/cli/image-cache/sess_fb5b5dc2-a7f9-4d17-b92c-3e11af857669/image-025cd0a2f071a856093a25810e968fca.png';
const win = 'C:\\Users\\rafeq\\.zcode\\cli\\image-cache\\sess_fb5b5dc2-a7f9-4d17-b92c-3e11af857669\\image-025cd0a2f071a856093a25810e968fca.png';

test('finds a unix zCode image-cache path in a paragraph that does not end in .png', () => {
  const text = `The image was omitted from the provider request because the selected model does not support image input. Path: ${unix}\n\nPolicz ile widzisz słów beodes`;
  assert.deepEqual(findZcodeCachePaths(text), [unix]);
  assert.equal(bodyHasImage({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] }), true);
  assert.equal(looksLikeOmittedImage({ messages: [{ role: 'user', content: text }] }), true);
});

test('finds a Windows zCode image-cache path', () => {
  const text = `omitted because the selected model does not support image input. ${win}`;
  assert.deepEqual(findZcodeCachePaths(text), [win]);
  assert.equal(isZcodeImageCachePath(win), true);
});

test('redactSecrets strips data URLs and bearer tokens', () => {
  const s = redactSecrets('Bearer abcdefghijklmnop data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
  assert.match(s, /<redacted-key>/);
  assert.match(s, /\[data-url \d+ chars\]/);
  assert.doesNotMatch(s, /iVBORw0KGgo/);
});

test('file_url parts inside zCode cache become fenced text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-file-'));
  const file = path.join(dir, '.zcode', 'cli', 'image-cache', 'sess', 'note.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'hello from a paste');
  const body = {
    messages: [{
      role: 'user',
      content: [{ type: 'file_url', file_url: { url: file } }],
    }],
  };
  await bridgeFiles(body, { log() {} });
  const text = body.messages[0].content.map((p) => p.text || '').join('');
  assert.match(text, /hello from a paste/);
  assert.doesNotMatch(JSON.stringify(body), /file_url/);
});

test('file-cache paths are allowed and outsider paths are refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-file-'));
  const inside = path.join(dir, '.zcode', 'cli', 'file-cache', 'sess', 'doc.txt');
  const outsider = path.join(dir, 'secret.txt');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, 'inside-ok');
  fs.writeFileSync(outsider, 'do-not-read');
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'file', file: { url: inside } },
        { type: 'document', source: { type: 'url', url: outsider } },
      ],
    }],
  };
  await bridgeFiles(body, { log() {} });
  const blob = JSON.stringify(body);
  assert.match(blob, /inside-ok/);
  assert.doesNotMatch(blob, /do-not-read/);
  assert.match(blob, /could not be read|ILLEGIBLE|refused/i);
});

test('PDF bytes without pdftotext become an ILLEGIBLE note', async () => {
  const body = {
    messages: [{
      role: 'user',
      content: [{
        type: 'file',
        file: { file_data: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 fake').toString('base64')}` },
      }],
    }],
  };
  await bridgeFiles(body, { log() {}, extractPdf: async () => null });
  const text = body.messages[0].content.map((p) => p.text || '').join('');
  assert.match(text, /ILLEGIBLE: PDF/);
});

test('isFilePart ignores image file_url parts', () => {
  assert.equal(isFilePart({ type: 'file_url', file_url: { url: '/tmp/.zcode/cli/image-cache/x.png' } }), false);
  assert.equal(isFilePart({ type: 'file_url', file_url: { url: '/tmp/.zcode/cli/file-cache/x.pdf' } }), true);
});
