/** Client-observed visible-text throughput. No provider usage totals or I/O. */
export const MAX_VISIBLE_CHARS = 256 * 1024;
const MAX_ITEMS = 128;
const MAX_THREADS = 32;
const MAX_RETIRED_OBSERVERS = 64;
const LIVE_WINDOW_MS = 5000;
const STATES = new Set(['collecting', 'provisional', 'completed']);

function validText(text, firstText) {
  return typeof text === 'string' && typeof firstText === 'string'
    && text.length <= MAX_VISIBLE_CHARS && firstText.length <= MAX_VISIBLE_CHARS
    && text.startsWith(firstText);
}

const utf8 = new TextEncoder();

/** Count final full-text tokens extending beyond the first delta's byte boundary. */
export function countVisibleTokens(text, firstText, encoder) {
  if (!validText(text, firstText) || !firstText.length
    || typeof encoder?.encode !== 'function' || typeof encoder?.tokenByteLength !== 'function') return null;
  try {
    // A stream chunk can end between an emoji's UTF-16 surrogate pair. Such a
    // dangling high surrogate has no completed UTF-8 boundary in the full text.
    const lastUnit = firstText.charCodeAt(firstText.length - 1);
    const stableFirst = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? firstText.slice(0, -1) : firstText;
    const boundary = utf8.encode(stableFirst).length;
    const fullBytes = utf8.encode(text).length;
    const tokens = encoder.encode(text);
    if (!tokens || !Number.isSafeInteger(tokens.length)) return null;
    let byteEnd = 0;
    let count = 0;
    for (const token of tokens) {
      const length = encoder.tokenByteLength(token);
      if (!Number.isSafeInteger(length) || length <= 0) return null;
      byteEnd += length;
      if (byteEnd > boundary) count += 1;
    }
    if (byteEnd !== fullBytes) return null;
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}

// In-memory consistency fingerprints, never emitted. Keep no message bodies.
function fingerprint(text, length = text.length) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < length; i += 1) {
    const unit = text.charCodeAt(i);
    a = Math.imul(a ^ unit, 0x01000193);
    b = Math.imul(b ^ unit, 0x85ebca6b);
  }
  return `${a >>> 0}:${b >>> 0}`;
}

const revision = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const sameReading = (a, b) => a.state === b.state && a.textLength === b.textLength
  && a.textHash === b.textHash && a.firstLength === b.firstLength && a.firstHash === b.firstHash
  && a.deltaCount === b.deltaCount && a.durationMs === b.durationMs;
const sameText = (a, b) => a.textLength === b.textLength && a.textHash === b.textHash
  && a.firstLength === b.firstLength && a.firstHash === b.firstHash;

function summary(records) {
  let tokens = 0;
  let durationMs = 0;
  let samples = 0;
  for (const record of records) {
    if (!(record.tokens > 0) || !(record.durationMs > 0)) continue;
    tokens += record.tokens;
    durationMs += record.durationMs;
    samples += 1;
  }
  return { tps: durationMs > 0 ? tokens / (durationMs / 1000) : null,
    tokens, seconds: durationMs / 1000, measured_samples: samples };
}

function result(thread, extra = {}) {
  const records = thread ? [...thread.records.values()] : [];
  const completed = summary(records.filter(record => record.state === 'completed'));
  const current = records.filter(record => !thread.activity || record.turnId === thread.activity.turnId);
  // 短消息常在一次 5 秒采样前就已结束。显示最近一段回复，不能退回跨轮次历史平均，抹平新输出的变化。
  const latest = records.filter(record => record.state === 'completed').sort((a, b) => b.order - a.order)[0];
  const confirmed = summary(latest ? [latest] : []);
  const liveRecord = current.filter(record => (!thread.activity || thread.activity.phase === 'output') && record.state === 'provisional'
    && thread.present.has(record.key) && record.tokens > 0 && record.durationMs > 0)
    .sort((a, b) => b.order - a.order)[0];
  let live = liveRecord ? summary([liveRecord]) : null;
  if (liveRecord?.points?.length >= 2 && Number.isFinite(thread.sampledAtMs)) {
    // 正文输出中采用最近两次采样之间的 token 增量；无新正文的区间保留有效读数。
    // 分词仍基于整段正文的 BPE，只对已确认的累计 token 数做差，不独立分词网络块。
    const [base, current] = liveRecord.points.slice(-2);
    const tokens = Math.max(0, current.tokens - base.tokens);
    const seconds = Math.max(0, current.at - base.at) / 1000;
    if (tokens > 0 && seconds > 0) {
      live = { tps: tokens / seconds, tokens, seconds, measured_samples: 1 };
      liveRecord.lastLive = live;
    } else {
      // 没有新正文不代表模型速度为 0；保留最近一次有实际 token 增量的有效读数。
      live = liveRecord.lastLive ?? live;
    }
  }
  const selected = live ?? confirmed;
  return {
    measurement_method: 'visible_stream',
    scope: 'current_observer_recent_visible_items',
    state: live ? 'provisional' : confirmed.measured_samples ? 'completed' : 'noData',
    phase: thread?.activity?.phase ?? 'idle',
    ...selected,
    completed,
    confirmed,
    confirmed_key: latest?.key ?? null,
    sample_key: liveRecord?.key ?? latest?.key ?? null,
    invalidated_keys: records.filter(record => record.state === 'invalid').map(record => record.key),
    interrupted_keys: records.filter(record => record.state === 'invalid' && record.issue === 'thread_not_active').map(record => record.key),
    live,
    ...(liveRecord?.points?.length ? { speed_window_ms: LIVE_WINDOW_MS } : {}),
    sample_limit: MAX_ITEMS,
    ...extra,
  };
}

/**
 * update(threadId, snapshot) consumes a non-draining observer snapshot.
 * A new observer starts a fresh measurement epoch. Older known observers and
 * lower revisions cannot restore stale samples. Invalid items are tombstones.
 * Counts cover at most the latest 128 observed items of the current observer.
 */
export class VisibleStreamMeter {
  constructor(encoder) {
    if (typeof encoder?.encode !== 'function' || typeof encoder?.tokenByteLength !== 'function') {
      throw new TypeError('An encoder with encode(text) and tokenByteLength(id) is required');
    }
    this.encoder = encoder;
    this.threads = new Map();
  }

  update(threadId, snapshot) {
    if (!id(threadId) || !snapshot || !id(snapshot.observerId) || !Array.isArray(snapshot.items)) {
      return result(null, { issue: 'invalid_snapshot' });
    }
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = { observerId: snapshot.observerId, retired: new Set(), records: new Map(),
        present: new Set(), revision: null, order: 0 };
    } else if (thread.observerId !== snapshot.observerId) {
      if (thread.retired.has(snapshot.observerId)) return result(thread, { ignored: true, issue: 'retired_observer' });
      thread.retired.add(thread.observerId);
      // The coordinator reads the current renderer serially; only recent
      // retired ids are needed to reject delayed replies across reloads.
      while (thread.retired.size > MAX_RETIRED_OBSERVERS) {
        thread.retired.delete(thread.retired.values().next().value);
      }
      thread.observerId = snapshot.observerId;
      thread.records.clear();
      thread.present.clear();
      thread.revision = null;
      thread.order = 0;
      thread.sampledAtMs = null;
      thread.activity = null;
    }
    this.threads.delete(threadId);
    this.threads.set(threadId, thread);
    while (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value);

    const snapshotRevision = revision(snapshot.revision);
    if (snapshotRevision !== null && thread.revision !== null && snapshotRevision < thread.revision) {
      return result(thread, { ignored: true, issue: 'stale_snapshot' });
    }
    if (snapshot.delta === true && (snapshot.baseRevision !== thread.revision || !Array.isArray(snapshot.present))) {
      return result(null, { issue: 'snapshot_resync_required' });
    }
    if (Number.isFinite(snapshot.sampledAtMs) && snapshot.sampledAtMs >= 0) {
      if (Number.isFinite(thread.sampledAtMs) && snapshot.sampledAtMs < thread.sampledAtMs) {
        return result(thread, { ignored: true, issue: 'stale_snapshot' });
      }
      thread.sampledAtMs = snapshot.sampledAtMs;
    }
    const activity = snapshot.activity;
    thread.activity = id(activity?.turnId) && ['waiting', 'thinking', 'tool', 'output', 'idle'].includes(activity.phase)
      ? { turnId: activity.turnId, phase: activity.phase } : null;
    thread.present = new Set(snapshot.delta === true ? snapshot.present.filter(pair => Array.isArray(pair)
      && id(pair[0]) && id(pair[1])).map(pair => JSON.stringify(pair)) : []);
    for (const item of snapshot.items) {
      if (!item || !id(item.turnId) || !id(item.itemId)
        || (item.threadId !== undefined && item.threadId !== threadId)) continue;
      const key = JSON.stringify([item.turnId, item.itemId]);
      thread.present.add(key);
      this.accept(thread, key, item, snapshotRevision);
    }
    if (snapshotRevision !== null) thread.revision = snapshotRevision;
    const oldest = [...thread.records.values()].sort((a, b) => a.order - b.order);
    while (thread.records.size > MAX_ITEMS) thread.records.delete(oldest.shift().key);
    // 即使只有空增量快照，也推进采样时间；否则暂停输出会一直保留上一个区间的速度。
    for (const record of thread.records.values()) {
      if (record.state !== 'provisional' || !thread.present.has(record.key) || !record.points
        || !(record.tokens > 0) || !Number.isFinite(thread.sampledAtMs) || thread.sampledAtMs < record.lastDeltaMs) continue;
      const point = { at: thread.sampledAtMs, tokens: record.tokens };
      if (record.points.at(-1)?.at === point.at) record.points[record.points.length - 1] = point;
      else record.points.push(point);
      while (record.points.length > 2) record.points.shift();
    }
    return result(thread);
  }

  accept(thread, key, item, snapshotRevision) {
    const previous = thread.records.get(key);
    const itemRevision = revision(item.revision) ?? snapshotRevision;
    if (previous?.revision !== null && previous?.revision !== undefined && itemRevision !== null
      && itemRevision < previous.revision) return;
    if (previous?.state === 'invalid') return;
    const invalidate = issue => thread.records.set(key, { key, state: 'invalid', tokens: null,
      durationMs: 0, revision: itemRevision, order: ++thread.order, issue });
    if (item.invalid === true || item.state === 'invalid') {
      // 离开会话终止后续计量，但不否认离开前已经显示的区间读数；其他失效原因仍撤销历史显示。
      invalidate(item.issue === 'thread_not_active' ? 'thread_not_active' : 'observer_invalid');
      return;
    }
    if (!STATES.has(item.state) || !validText(item.text, item.firstText)
      || !Number.isSafeInteger(item.deltaCount) || item.deltaCount < 0
      || !Number.isFinite(item.durationMs) || item.durationMs < 0
      || (item.deltaCount === 0 && (item.text.length || item.firstText.length))
      || (item.deltaCount > 0 && !item.firstText.length)
      || (item.deltaCount === 1 && item.text !== item.firstText)
      || (item.deltaCount < 2 && item.durationMs !== 0)
      || (revision(item.revision) !== null && snapshotRevision !== null && item.revision > snapshotRevision)) {
      invalidate('invalid_reading');
      return;
    }
    const next = { key, turnId: item.turnId, state: item.state, durationMs: item.durationMs, deltaCount: item.deltaCount,
      textLength: item.text.length, textHash: fingerprint(item.text),
      firstLength: item.firstText.length, firstHash: fingerprint(item.firstText), revision: itemRevision };
    if (previous) {
      const changed = !sameReading(previous, next);
      const firstChanged = previous.firstLength > 0
        && (next.firstLength !== previous.firstLength || next.firstHash !== previous.firstHash);
      const shrank = next.textLength < previous.textLength || next.deltaCount < previous.deltaCount
        || next.durationMs < previous.durationMs;
      const prefixChanged = !shrank && fingerprint(item.text, previous.textLength) !== previous.textHash;
      const completedChanged = previous.state === 'completed' && changed;
      const phaseRegressed = previous.state === 'provisional' && next.state === 'collecting';
      const revisionConflict = changed && itemRevision !== null && itemRevision === previous.revision;
      if (firstChanged || shrank || prefixChanged || completedChanged || phaseRegressed || revisionConflict) {
        invalidate('conflicting_reading');
        return;
      }
      if (!changed) {
        previous.revision = itemRevision ?? previous.revision;
        return;
      }
    }
    next.tokens = previous && sameText(previous, next) ? previous.tokens : null;
    if (next.deltaCount >= 2 && next.durationMs > 0 && next.textLength > next.firstLength) {
      if (!(previous && sameText(previous, next))) {
        next.tokens = countVisibleTokens(item.text, item.firstText, this.encoder);
        if (next.tokens === null) {
          invalidate('unmeasurable_tokens');
          return;
        }
      }
    }
    if (Number.isFinite(item.firstDeltaMs) && Number.isFinite(item.lastDeltaMs)
      && item.firstDeltaMs >= 0 && item.lastDeltaMs >= item.firstDeltaMs
      && Math.abs(item.lastDeltaMs - item.firstDeltaMs - item.durationMs) < 0.01) {
      next.lastDeltaMs = item.lastDeltaMs;
      next.points = previous?.points ? [...previous.points] : [{ at: item.firstDeltaMs, tokens: 0 }];
      if (previous?.lastLive) next.lastLive = previous.lastLive;
    }
    next.order = ++thread.order;
    thread.records.set(key, next);
  }

  clear(threadId) {
    if (threadId === undefined) this.threads.clear();
    else this.threads.delete(threadId);
  }
}
