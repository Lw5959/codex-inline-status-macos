import test from 'node:test';
import assert from 'node:assert/strict';
import { VisibleStreamMeter, countVisibleTokens, MAX_VISIBLE_CHARS } from '../src/visible_stream_meter.mjs';

const encode = text => Array.from(text);
const bytes = text => new TextEncoder().encode(text).length;
const encoder = { encode, tokenByteLength: bytes };
const reading = (overrides = {}) => ({ turnId: 'turn-1', itemId: 'item-1', text: 'abcde',
  firstText: 'a', deltaCount: 3, durationMs: 1000, state: 'completed', ...overrides });
const snapshot = (items, revision = 1, observerId = 'observer-1') => ({ observerId, revision, items });

test('repeated renderer reloads keep retired observer identities bounded', () => {
  const meter = new VisibleStreamMeter(encoder);
  for (let i=0;i<2000;i++) meter.update('thread', snapshot([],1,`observer-${i}`));
  assert.equal(meter.threads.get('thread').retired.size,64);
  assert.equal(meter.update('thread',snapshot([],1,'observer-1998')).ignored,true);
});

test('uses final full-text byte boundaries rather than subtracting independent BPE counts', () => {
  const merged = { encode: text => ({ a: ['a'], ab: ['ab'], abc: ['ab', 'c'] })[text], tokenByteLength: bytes };
  assert.equal(countVisibleTokens('abc', 'a', merged), 2);
  assert.equal(countVisibleTokens('ab', 'a', merged), 1);
  const word = { encode: () => ['hello'], tokenByteLength: bytes };
  assert.equal(countVisibleTokens('hello', 'hel', word), 1);
  assert.equal(countVisibleTokens('z', 'a', encoder), null);
  assert.equal(countVisibleTokens('ab', '', encoder), null);
  assert.equal(countVisibleTokens('ab', 'a', { ...encoder, encode: () => { throw new Error('tokenizer'); } }), null);
  assert.equal(countVisibleTokens('ab', 'a', { encode: () => [1], tokenByteLength: () => 99 }), null);
});

test('counts UTF-8 token pieces crossing emoji chunk boundaries without surrogate replacement', () => {
  const tokenBytes = { 1: 1, 2: 2, 3: 2, 4: 1 };
  const emoji = { encode: () => [1, 2, 3, 4], tokenByteLength: token => tokenBytes[token] };
  assert.equal(countVisibleTokens('a😀b', 'a\ud83d', emoji), 3);
  assert.equal(countVisibleTokens('a😀b', 'a😀', emoji), 1);
  assert.equal(countVisibleTokens('😀b', '\ud83d', { encode: () => [2, 3, 4], tokenByteLength: token => tokenBytes[token] }), 3);
});

test('empty history, one chunk, zero duration, and zero token growth never show speed', () => {
  const meter = new VisibleStreamMeter(encoder);
  assert.equal(meter.update('thread', snapshot([])).state, 'noData');
  for (const [index, overrides] of [
    { text: 'a', firstText: 'a', deltaCount: 1, durationMs: 0 },
    { durationMs: 0 },
    { text: 'a', firstText: 'a' },
  ].entries()) {
    const value = meter.update('thread', snapshot([reading({ itemId: `item-${index}`, ...overrides })], index + 2));
    assert.equal(value.tps, null);
    assert.equal(value.measured_samples, 0);
  }
});

test('completed display follows the latest reply while historical totals remain independently available', () => {
  const meter = new VisibleStreamMeter(encoder);
  const items = [reading(), reading({ itemId: 'item-2', text: 'abcdefg', durationMs: 3000 })];
  const value = meter.update('thread', snapshot(items));
  assert.equal(value.tps, 2);
  assert.equal(value.tokens, 6);
  assert.equal(value.seconds, 3);
  assert.equal(value.measured_samples, 1);
  assert.equal(value.completed.tps, 10 / 4);
  assert.equal(value.completed.measured_samples, 2);
  assert.equal(value.state, 'completed');
  assert.deepEqual(meter.update('thread', snapshot(items)), value);
  assert.deepEqual(meter.update('thread', snapshot(items, 2)), value);
});

test('provisional readings replace their own totals; polling never adds idle time', () => {
  let calls = 0;
  const meter = new VisibleStreamMeter({ ...encoder, encode: text => { calls += 1; return encode(text); } });
  const first = reading({ state: 'provisional' });
  let value = meter.update('thread', snapshot([first]));
  assert.equal(value.tps, 4);
  assert.equal(calls, 1);
  value = meter.update('thread', snapshot([first], 2));
  assert.equal(calls, 1);
  assert.equal(value.seconds, 1);
  value = meter.update('thread', snapshot([reading({ text: 'abcdefg', durationMs: 2000, deltaCount: 4, state: 'provisional' })], 3));
  assert.equal(value.tokens, 6);
  assert.equal(value.seconds, 2);
  assert.equal(value.tps, 3);
  value = meter.update('thread', snapshot([reading({ text: 'abcdefg', durationMs: 2000, deltaCount: 4 })], 4));
  assert.equal(value.tokens, 6);
  assert.equal(value.measured_samples, 1);
  assert.equal(calls, 2);
});

test('most recent live item is displayed separately from accumulated completions', () => {
  const meter = new VisibleStreamMeter(encoder);
  const value = meter.update('thread', snapshot([
    reading(),
    reading({ itemId: 'old-live', text: 'abc', durationMs: 2000, state: 'provisional' }),
    reading({ itemId: 'new-live', text: 'abcdefgh', durationMs: 500, state: 'provisional' }),
  ]));
  assert.equal(value.state, 'provisional');
  assert.equal(value.tps, 14);
  assert.equal(value.completed.tps, 4);
  assert.equal(value.measured_samples, 1);
});

test('a missing provisional item stops displaying while completed history is retained', () => {
  const meter = new VisibleStreamMeter(encoder);
  meter.update('thread', snapshot([reading(), reading({ itemId: 'live', state: 'provisional' })]));
  const value = meter.update('thread', snapshot([], 2));
  assert.equal(value.state, 'completed');
  assert.equal(value.measured_samples, 1);
  assert.equal(value.live, null);
});

test('new observers reset history and retired observers cannot bring old values back', () => {
  const meter = new VisibleStreamMeter(encoder);
  meter.update('thread', snapshot([reading()]));
  assert.equal(meter.update('thread', snapshot([], 1, 'observer-2')).state, 'noData');
  const stale = meter.update('thread', snapshot([reading()], 999));
  assert.equal(stale.state, 'noData');
  assert.equal(stale.issue, 'retired_observer');
});

test('thread and turn identity isolate samples and foreign thread rows are ignored', () => {
  const meter = new VisibleStreamMeter(encoder);
  meter.update('A', snapshot([reading()]));
  assert.equal(meter.update('B', snapshot([])).tps, null);
  const value = meter.update('A', snapshot([
    reading({ turnId: 'turn-2' }),
    reading({ itemId: 'foreign', threadId: 'B' }),
  ], 2));
  assert.equal(value.measured_samples, 1);
  assert.equal(value.completed.measured_samples, 2);
});

test('a newer invalid tombstone revokes prior completions permanently', () => {
  const meter = new VisibleStreamMeter(encoder);
  meter.update('thread', snapshot([reading()]));
  let value = meter.update('thread', snapshot([reading({ state: 'invalid', text: '', firstText: '', issue: 'late_delta' })], 2));
  assert.equal(value.tps, null);
  value = meter.update('thread', snapshot([reading()], 3));
  assert.equal(value.tps, null);
});

test('inactive-thread interruptions remain separate from conflicting sample invalidations', () => {
  const meter=new VisibleStreamMeter(encoder);
  const original=meter.update('thread',snapshot([reading({state:'provisional'})]));
  assert.equal(typeof original.sample_key,'string');
  const interrupted=meter.update('thread',snapshot([reading({state:'invalid',issue:'thread_not_active'})],2));
  assert.equal(interrupted.tps,null);assert.deepEqual(interrupted.interrupted_keys,[original.sample_key]);
  assert.deepEqual(interrupted.invalidated_keys,[original.sample_key]);
});

test('older snapshot and older item revisions cannot undo newer results or invalidations', () => {
  const meter = new VisibleStreamMeter(encoder);
  meter.update('thread', snapshot([reading({ revision: 5 })], 5));
  assert.equal(meter.update('thread', snapshot([reading({ state: 'invalid' })], 4)).tps, 4);
  assert.equal(meter.update('thread', snapshot([reading({ state: 'invalid', revision: 4 })], 6)).tps, 4);
  meter.update('thread', snapshot([reading({ state: 'invalid', revision: 7 })], 7));
  assert.equal(meter.update('thread', snapshot([reading({ revision: 5 })], 8)).tps, null);
});

test('changed completed data, regressions, and rewritten prefixes fail closed', () => {
  for (const change of [
    { text: 'abcdf' },
    { state: 'provisional' },
    { durationMs: 999 },
    { deltaCount: 2 },
    { firstText: 'ab' },
  ]) {
    const meter = new VisibleStreamMeter(encoder);
    meter.update('thread', snapshot([reading()]));
    assert.equal(meter.update('thread', snapshot([reading(change)], 2)).tps, null);
  }
  const meter = new VisibleStreamMeter(encoder);
  meter.update('thread', snapshot([reading({ state: 'provisional' })]));
  assert.equal(meter.update('thread', snapshot([reading({ state: 'provisional', text: 'axyzefg', deltaCount: 4, durationMs: 2000 })], 2)).tps, null);
});

test('conflicting duplicate identities and equal revisions revoke earlier samples', () => {
  const meter = new VisibleStreamMeter(encoder);
  assert.equal(meter.update('thread', snapshot([reading(), reading({ durationMs: 2 })])).tps, null);
  const other = new VisibleStreamMeter(encoder);
  other.update('thread', snapshot([reading({ state: 'provisional' })]));
  assert.equal(other.update('thread', snapshot([reading({ text: 'abcdef', deltaCount: 4, durationMs: 2000, state: 'provisional' })])).tps, null);
});

test('tokenizer failure or excessive text removes a previously valid sample', () => {
  let fail = false;
  const meter = new VisibleStreamMeter({ ...encoder, encode: text => { if (fail) throw Error('no'); return encode(text); } });
  meter.update('thread', snapshot([reading({ state: 'provisional' })]));
  fail = true;
  assert.equal(meter.update('thread', snapshot([reading({ text: 'abcdef', deltaCount: 4, durationMs: 2000, state: 'provisional' })], 2)).tps, null);
  const bounded = new VisibleStreamMeter(encoder);
  bounded.update('thread', snapshot([reading({ state: 'provisional' })]));
  assert.equal(bounded.update('thread', snapshot([reading({ text: 'a'.repeat(MAX_VISIBLE_CHARS + 1), deltaCount: 4, durationMs: 2000, state: 'provisional' })], 2)).tps, null);
});

test('one first chunk can have many tokens, and no arbitrary throughput ceiling is applied', () => {
  const meter = new VisibleStreamMeter(encoder);
  const value = meter.update('thread', snapshot([reading({ text: 'abcdefghij', firstText: 'abcdefghi', deltaCount: 2, durationMs: 0.0001 })]));
  assert.equal(value.tokens, 1);
  assert.equal(value.tps, 10_000_000);
});

test('records are bounded, carry no text, and output exposes no bodies or fingerprints', () => {
  const meter = new VisibleStreamMeter(encoder);
  const items = Array.from({ length: 130 }, (_, i) => reading({ itemId: `item-${i}` }));
  const value = meter.update('thread', snapshot(items));
  assert.equal(value.measured_samples, 1);
  assert.equal(value.completed.measured_samples, 128);
  const record = [...meter.threads.get('thread').records.values()][0];
  assert.equal('text' in record, false);
  assert.equal('firstText' in record, false);
  assert.equal(JSON.stringify(value).includes('abcde'), false);
  assert.equal(JSON.stringify(value).includes('textHash'), false);
  for (let i = 0; i < 33; i++) meter.update(`thread-${i}`, snapshot([]));
  assert.equal(meter.threads.size, 32);
});

test('malformed snapshots fail closed and clearing a thread resets its history', () => {
  const meter = new VisibleStreamMeter(encoder);
  meter.update('thread', snapshot([reading()]));
  assert.equal(meter.update('thread', null).tps, null);
  meter.clear('thread');
  assert.equal(meter.update('thread', snapshot([])).tps, null);
  meter.clear();
  assert.equal(meter.threads.size, 0);
});

test('incremental snapshots do not recount completed text and require the exact cursor', () => {
  let calls = 0;
  const meter = new VisibleStreamMeter({ ...encoder, encode: text => { calls++; return encode(text); } });
  meter.update('thread', snapshot([reading({ revision: 1 })], 1));
  const delta = { ...snapshot([], 2), delta: true, baseRevision: 1, present: [['turn-1', 'item-1']] };
  assert.equal(meter.update('thread', delta).tps, 4);
  assert.equal(calls, 1, '空闲增量不能重复分词或遍历历史正文');
  assert.equal(meter.update('thread', { ...delta, revision: 3 }).issue, 'snapshot_resync_required');
  assert.equal(meter.update('thread', { ...delta, revision: 3, baseRevision: 2,
    items: [reading({ state: 'invalid', text: '', firstText: '', revision: 3 })] }).tps, null);
});

test('live speed follows recent output and holds through pauses without changing final averages', () => {
  const meter = new VisibleStreamMeter(encoder);
  const update = (length, at, rev, state = 'provisional') => meter.update('thread', {
    ...snapshot([reading({ text: 'a'.repeat(length + 1), firstText: 'a', deltaCount: rev + 1,
      durationMs: at, firstDeltaMs: 0, lastDeltaMs: at, revision: rev, state })], rev), sampledAtMs: at,
  });
  assert.equal(update(10, 1000, 1).tps, 10);
  assert.equal(update(20, 6000, 2).tps, 2);
  assert.equal(update(60, 11000, 3).tps, 8, '采用最近 5 秒的增量，不能继续显示整条消息平均值');
  const idle = (at, rev) => meter.update('thread', { ...snapshot([], rev), sampledAtMs: at,
    delta: true, baseRevision: rev - 1, present: [['turn-1', 'item-1']] });
  assert.equal(idle(16000, 4).tps, 8);
  assert.equal(idle(21000, 5).tps, 8, '暂停期间保留最近一次有效速度，不归零');
  const completed = update(60, 11000, 6, 'completed');
  // 最终快照的采样时刻不能回退；重用真实完成接收时刻验证整段的准确平均。
  assert.equal(completed.ignored, true);
  const final = meter.update('thread', { ...snapshot([reading({ text: 'a'.repeat(61), firstText: 'a',
    deltaCount: 4, durationMs: 11000, firstDeltaMs: 0, lastDeltaMs: 11000, revision: 6, state: 'completed' })], 6), sampledAtMs: 22000 });
  assert.equal(final.tps, 60 / 11); assert.equal(final.tokens, 60); assert.equal(final.state, 'completed');
});

test('short replies update the latest result while pauses and new turns retain this conversation reading', () => {
  const meter = new VisibleStreamMeter(encoder);
  const first = meter.update('thread', { ...snapshot([reading()], 1), activity: { turnId: 'turn-1', phase: 'waiting' } });
  assert.equal(first.tps, 4, '一次采样前已结束的短消息也必须显示');
  const wait = meter.update('thread', { ...snapshot([], 2), delta: true, baseRevision: 1,
    present: [['turn-1', 'item-1']], activity: { turnId: 'turn-1', phase: 'tool' } });
  assert.equal(wait.tps, 4); assert.equal(wait.state, 'completed'); assert.equal(wait.phase, 'tool');
  const nextTurn = meter.update('thread', { ...snapshot([], 3), delta: true, baseRevision: 2,
    present: [['turn-1', 'item-1']], activity: { turnId: 'turn-2', phase: 'thinking' } });
  assert.equal(nextTurn.tps, 4, '下一轮无正文时保留本对话最近有效读数');
  const latest = meter.update('thread', { ...snapshot([reading({ turnId: 'turn-2', itemId: 'short', text: 'abcdefghijk' })], 4),
    activity: { turnId: 'turn-2', phase: 'idle' } });
  assert.equal(latest.tps, 10); assert.equal(latest.completed.tps, 7);
  assert.equal(latest.measured_samples, 1);
});

test('quiet intervals retain the last valid reading and never manufacture first-use data', () => {
  const meter = new VisibleStreamMeter(encoder);
  const waiting = (rev,at,items=[]) => ({ ...snapshot(items,rev), sampledAtMs:at,
    activity:{turnId:'turn-1',phase:'thinking'} });
  assert.equal(meter.update('thread',waiting(1,1000)).tps,null);
  assert.equal(meter.update('thread',waiting(2,6000)).tps,null);
  const output=meter.update('thread',waiting(3,11000,[reading()]));assert.equal(output.tps,4);
  const quiet=meter.update('thread',{...waiting(4,16000),delta:true,baseRevision:3,present:[['turn-1','item-1']]});
  assert.equal(quiet.tps,4);assert.equal(quiet.tokens,4);assert.equal(quiet.seconds,1);
  assert.equal(quiet.completed.tps,4,'空闲区间不能改变完整正文计量');
});
