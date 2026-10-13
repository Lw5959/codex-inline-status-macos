/* Client-visible agent text only. Memory-only, passive, and independently removable. */
(() => {
  "use strict";
  const NAME = "__CODEX_VISIBLE_STREAM__";
  const VERSION = "1.0.1";
  if (window[NAME]?.version === VERSION) return;
  window[NAME]?.destroy?.();

  const installedAtMs = Date.now();
  const observerId = typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `visible-${installedAtMs.toString(36)}-${Math.random().toString(36).slice(2)}`;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_ITEM_CHARS = 256 * 1024;
  const MAX_SNAPSHOT_CHARS = 512 * 1024;
  const records = new Map();
  const threads = new Map();
  let revision = 0;
  let active = true;

  function forget(key) {
    const record = records.get(key);
    if (!record) return;
    records.delete(key);
    const thread = threads.get(record.threadId);
    thread?.delete(key);
    if (thread?.size === 0) threads.delete(record.threadId);
  }

  function invalidate(record, issue) {
    record.state = "invalid";
    record.issue = issue;
    record.text = "";
    record.firstText = "";
  }

  function cost(record) { return record.text.length + record.firstText.length; }

  function retain(record) {
    let thread = threads.get(record.threadId);
    if (!thread) {
      while (threads.size >= 32) {
        for (const key of [...threads.values().next().value.keys()]) forget(key);
      }
      thread = new Map();
    }
    record.revision = ++revision;
    threads.delete(record.threadId); threads.set(record.threadId, thread);
    thread.delete(record.key); thread.set(record.key, record);
    records.delete(record.key); records.set(record.key, record);
    while (records.size > 128) forget(records.keys().next().value);

    // Reject whole old items instead of returning truncated strings as samples.
    let characters = [...thread.values()].reduce((sum, item) => sum + cost(item), 0);
    for (const item of [...thread.values()]) {
      if (characters <= MAX_SNAPSHOT_CHARS) break;
      const size = cost(item);
      if (!size) continue;
      invalidate(item, "snapshot_text_limit");
      item.revision = ++revision;
      characters -= size;
    }
  }

  function startedAt(params, item) {
    const value = item?.startedAtMs ?? params.startedAtMs;
    return typeof value === "number" && Number.isFinite(value) && value >= installedAtMs ? value : null;
  }

  function elapsed(record) {
    return record.firstDeltaMs !== null && record.lastDeltaMs !== null
      ? record.lastDeltaMs - record.firstDeltaMs : 0;
  }

  function activeThreads() {
    try {
      const frontend = window.__CODEX_INLINE_STATUS__;
      if (typeof frontend?.currentThreadIds === "function") {
        const ids = frontend.currentThreadIds();
        return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === "string" && UUID.test(id)).map(id => id.toLowerCase()) : []);
      }
      const bindings = frontend?.discover?.();
      return new Set(Array.isArray(bindings) ? bindings
        .map(binding => binding?.threadId)
        .filter(id => typeof id === "string" && UUID.test(id))
        .map(id => id.toLowerCase()) : []);
    } catch { return new Set(); }
  }

  function onMessage(event) {
    if (!active || (event.source !== null && event.source !== window)) return;
    const data = event.data;
    if (!data || data.type !== "mcp-notification" || data.hostId !== "local") return;
    const params = data.params;
    if (!params || typeof params.threadId !== "string" || typeof params.turnId !== "string"
      || !UUID.test(params.threadId) || !UUID.test(params.turnId)) return;
    const start = data.method === "item/started";
    const complete = data.method === "item/completed";
    const delta = data.method === "item/agentMessage/delta";
    if (!start && !complete && !delta) return;
    if ((start || complete) && params.item?.type !== "agentMessage") return;
    if (delta && (typeof params.delta !== "string" || params.delta.length === 0)) return;
    const itemId = start || complete ? params.item.id : params.itemId;
    if (typeof itemId !== "string" || !itemId.length || itemId.length > 160) return;

    const threadId = params.threadId.toLowerCase();
    const turnId = params.turnId.toLowerCase();
    const key = JSON.stringify([threadId, turnId, itemId]);
    const now = performance.now();
    const visibleThreads = activeThreads();
    // A renderer can receive broadcast notifications for other windows. A
    // missing binding, including a temporary route gap, ends an in-flight item.
    for (const tracked of [...records.values()]) {
      if (!tracked.closed && tracked.state !== "invalid" && !visibleThreads.has(tracked.threadId)) {
        invalidate(tracked, "thread_not_active"); retain(tracked);
      }
    }
    let record = records.get(key);
    if (!visibleThreads.has(threadId)) {
      if (record && record.state !== "invalid") { invalidate(record, "thread_not_active"); retain(record); }
      return;
    }
    if (record?.state === "invalid") return;
    if (!record) record = {
      key, threadId, turnId, itemId, text: "", firstText: "", deltaCount: 0,
      firstDeltaMs: null, lastDeltaMs: null, lastEventMs: null, startTimeMs: null,
      serverStartedAtMs: null, serverCompletedAtMs: null, closed: false,
      state: "collecting", issue: null, revision: 0,
    };
    if (!Number.isFinite(now) || now < 0 || (record.lastEventMs !== null && now < record.lastEventMs)) {
      invalidate(record, "non_monotonic_time"); retain(record); return;
    }

    if (start) {
      const serverStart = startedAt(params, params.item);
      if (record.startTimeMs !== null) {
        if (serverStart !== record.serverStartedAtMs) invalidate(record, "conflicting_start");
        else if (record.deltaCount || record.closed) invalidate(record, "replayed_start");
        else return;
      } else if (record.lastEventMs !== null) invalidate(record, "missing_start");
      else if (serverStart === null) invalidate(record, "missing_or_historical_start");
      else if (typeof params.item.text === "string" && params.item.text.length) invalidate(record, "start_contains_text");
      else {
        record.startTimeMs = now;
        record.serverStartedAtMs = serverStart;
      }
    } else if (record.startTimeMs === null) {
      invalidate(record, "missing_start");
    } else if (delta) {
      if (record.closed) invalidate(record, "late_delta");
      else if (record.text.length + params.delta.length > MAX_ITEM_CHARS) invalidate(record, "item_text_limit");
      else {
        record.text += params.delta;
        record.deltaCount++;
        if (record.firstDeltaMs === null) {
          record.firstDeltaMs = now;
          record.firstText = params.delta;
        }
        record.lastDeltaMs = now;
        record.state = record.deltaCount >= 2 && elapsed(record) > 0 ? "provisional" : "collecting";
      }
    } else {
      const finalText = params.item.text;
      const completedAt = params.completedAtMs ?? params.item.completedAtMs ?? null;
      if (typeof finalText !== "string") invalidate(record, "missing_final_text");
      else if (finalText.length > MAX_ITEM_CHARS) invalidate(record, "item_text_limit");
      else if (finalText !== record.text) invalidate(record, "final_text_mismatch");
      else if (completedAt !== null && (typeof completedAt !== "number" || !Number.isFinite(completedAt) || completedAt < record.serverStartedAtMs)) invalidate(record, "invalid_completed_at");
      else if (record.closed) {
        if (completedAt !== record.serverCompletedAtMs) invalidate(record, "conflicting_completion");
        else return;
      } else if (record.deltaCount < 2 || elapsed(record) <= 0) invalidate(record, "insufficient_delta_span");
      else {
        record.closed = true;
        record.serverCompletedAtMs = completedAt;
        record.state = "completed";
      }
    }
    record.lastEventMs = now;
    retain(record);
  }

  const api = Object.freeze({
    version: VERSION,
    snapshot(threadId) {
      const thread = typeof threadId === "string" && UUID.test(threadId) ? threads.get(threadId.toLowerCase()) : null;
      return { observerId, revision, items: thread ? [...thread.values()].slice(-128).map(record => ({
        itemId: record.itemId, turnId: record.turnId, text: record.text, firstText: record.firstText,
        durationMs: record.state === "invalid" ? 0 : elapsed(record), deltaCount: record.deltaCount,
        state: record.state, issue: record.issue, revision: record.revision,
      })) : [] };
    },
    destroy() {
      active = false;
      window.removeEventListener("message", onMessage);
      records.clear(); threads.clear(); revision++;
      if (window[NAME] === api) delete window[NAME];
      return { removed: true };
    },
  });
  window[NAME] = api;
  window.addEventListener("message", onMessage);
})();
