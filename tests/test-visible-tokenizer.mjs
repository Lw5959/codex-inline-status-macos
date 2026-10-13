import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, tokenByteLength, tokenizerName } from '../src/visible_tokenizer.mjs';
import { countVisibleTokens } from '../src/visible_stream_meter.mjs';

const encoder = { encode, tokenByteLength };
test('bundled tokenizer has the expected fixed vocabulary and round-trip byte lengths', () => {
  assert.equal(tokenizerName, 'o200k_base');
  assert.deepEqual(encode('Hello, world!'), [13225, 11, 2375, 0]);
  for (const text of ['你好，世界！', 'Привет, мир!', '👋🏽 hello', '<|endoftext|>', '\n\t  ', '你😀好']) {
    assert.equal(encode(text).reduce((n, token) => n + tokenByteLength(token), 0), Buffer.byteLength(text));
  }
});
test('token count is based on final token byte boundaries, not chunk token sums', () => {
  const text = 'establishment';
  const first = 'est';
  const ids = encode(text);
  let at = 0;
  const expected = ids.filter(token => (at += tokenByteLength(token)) > Buffer.byteLength(first)).length;
  assert.equal(countVisibleTokens(text, first, encoder), expected);
  assert.equal(countVisibleTokens('😀 ok', '\ud83d', encoder), encode('😀 ok').length);
});
