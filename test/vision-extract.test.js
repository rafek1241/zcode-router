import test from 'node:test';
import assert from 'node:assert/strict';
import { findZcodeCachePaths, bodyHasImage, isZcodeImageCachePath } from '../src/vision.js';
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
