/** Client-observed visible-text throughput. No provider usage totals or I/O. */
export const MAX_VISIBLE_CHARS = 256 * 1024;
const MAX_ITEMS = 128;
const MAX_THREADS = 32;
const MAX_RETIRED_OBSERVERS = 64;
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
  const liveRecord = records.filter(record => record.state === 'provisional'
    && thread.present.has(record.key) && record.tokens > 0 && record.durationMs > 0)
    .sort((a, b) => b.order - a.order)[0];
  const live = liveRecord ? summary([liveRecord]) : null;
  const selected = live ?? completed;
  return {
    measurement_method: 'visible_stream',
    scope: 'current_observer_recent_visible_items',
    state: live ? 'provisional' : completed.measured_samples ? 'completed' : 'noData',
    ...selected,
    completed,
    live,
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
    }
    this.threads.delete(threadId);
    this.threads.set(threadId, thread);
    while (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value);

    const snapshotRevision = revision(snapshot.revision);
    if (snapshotRevision !== null && thread.revision !== null && snapshotRevision < thread.revision) {
      return result(thread, { ignored: true, issue: 'stale_snapshot' });
    }
    thread.present = new Set();
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
      invalidate('observer_invalid');
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
    const next = { key, state: item.state, durationMs: item.durationMs, deltaCount: item.deltaCount,
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
    next.order = ++thread.order;
    thread.records.set(key, next);
  }

  clear(threadId) {
    if (threadId === undefined) this.threads.clear();
    else this.threads.delete(threadId);
  }
}
