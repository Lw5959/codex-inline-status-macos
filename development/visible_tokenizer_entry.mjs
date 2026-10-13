// Fixed local text-tokenization convention. This is not a claim about the
// tokenizer or billable usage of the upstream model. No network is used.
import { Tiktoken } from '../tests/native-statusbar-deps/node_modules/js-tiktoken/dist/lite.js';
import ranks from '../tests/native-statusbar-deps/node_modules/js-tiktoken/dist/ranks/o200k_base.js';

const encoding = new Tiktoken(ranks);
export const tokenizerName = 'o200k_base';
export const tokenizerVersion = 'js-tiktoken@1.0.21';
export const encode = text => encoding.encode(text, [], []);
export const tokenByteLength = token => {
  const bytes = encoding.textMap.get(token);
  if (!bytes) throw new Error('Unknown ordinary token');
  return bytes.byteLength;
};
