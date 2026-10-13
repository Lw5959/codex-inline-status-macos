/* Local Codex composer status: independent of React and removable at runtime. */
(() => {
  "use strict";
  const NAME = "__CODEX_INLINE_STATUS__";
  if (window[NAME]?.version === "1.3.5") {
    window[NAME].discover();
    return;
  }
  window[NAME]?.destroy?.();
  // Selector compatibility references: CodexUsageMonitor 3.1.8,
  // assets/usage-placement.js and scripts/current-thread.mjs. Implementation
  // below is independent, uses in-flow hosts, and does not modify that project.
  const SELECTORS = ['.composer-surface-chrome', '[data-testid="composer"]', '[class*="ComposerLayoutRoot"]', '[data-testid*="composer-"]'];
  const EDITABLE = 'textarea,[contenteditable="true"]';
  const CODEX_INPUT = "data-codex-thread-reference-drop-target";
  const ATTRS = ["data-above-composer-conversation-id", "data-conversation-id", "data-thread-id"];
  const MARKERS = ATTRS.map(name => `[${name}]`).join(",");
  const PORTAL = "data-above-composer-portal";
  const STABLE_FOOTER = "[data-thread-scroll-footer]";
  const FOOTER_ROW = '[class*="ComposerLayoutFooter"]';
  const GAP_MS = 1200;
  const UUID = /(?:^|[^0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[^0-9a-f])/i;
  const DATA_UNAVAILABLE = new Set([
    "capacity_exceeded", "metrics_unavailable", "metrics_timeout", "backend_error",
    "ownership_unverified", "inherited_history", "state_unavailable", "no_thread",
    "source_unavailable", "logs_unavailable", "logs_index_unavailable",
    "catching_up", "logs_catching_up", "records_skipped", "monitor_disconnected",
  ]);
  const bindings = new Map();
  // Per-renderer, per-conversation last confirmed values. Never share another
  // window's clock/samples and never keep message bodies in this cache.
  const readings = new Map();
  let serial = 0;
  let active = true;
  let identityObserver;
  let resizeObserver;
  let layoutFrame = null;
  let layoutQueued = false;
  let layoutStyle;
  const observed = new Set();

  function allowed(node) {
    if (!node?.isConnected || node.closest('[aria-hidden="true"],[inert],[data-app-shell-active-page="false"]')) return false;
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  }

  function visible(node) {
    if (!allowed(node)) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  function identityAllowed(node) {
    // Codex hides an empty identity marker with empty:hidden. The marker's
    // identity is still valid while its containing conversation is active.
    return !!node?.isConnected
      && !node.closest('[aria-hidden="true"],[inert],[data-app-shell-active-page="false"]')
      && allowed(node.parentElement);
  }

  function identities(node) {
    const values = ATTRS.filter(name => node.hasAttribute(name)).map(name => String(node.getAttribute(name) || "").trim());
    if (values.some(value => /^chatgpt\s*:/i.test(value))) return { blocked: true, ids: [], invalid: false };
    return {
      blocked: false,
      ids: [...new Set(values.map(value => value.match(UUID)?.[1]?.toLowerCase()).filter(Boolean))],
      invalid: values.some(value => value && !value.match(UUID)),
    };
  }

  // A marker may be an empty sibling just above the composer. Resolve only in
  // the nearest enclosing scope; never select a global/nearest-screen title.
  function threadFor(composer, composers) {
    const ownCodexInput = [...composer.querySelectorAll(EDITABLE)].some(input => visible(input) && input.hasAttribute(CODEX_INPUT)
      && !composers.some(other => other !== composer && composer.contains(other) && other.contains(input)));
    const reject = reason => ({ kind: "reject", threadId: null, reason });
    const draft = () => ({ kind: "draft", threadId: null });
    const bound = threadId => ({ kind: "bound", threadId });
    for (let scope = composer; scope && scope !== document.body && scope !== document.documentElement; scope = scope.parentElement) {
      const own = identities(scope);
      if (own.blocked || own.invalid) return reject("foreign_or_invalid_identity");
      const others = composers.filter(candidate => candidate !== composer && scope.contains(candidate));
      // A composer's own identity belongs to that composer, but an identity
      // on a shared enclosing page cannot be borrowed by an unknown side chat.
      if (own.ids.length) return own.ids.length === 1 && (scope === composer || others.length === 0) ? bound(own.ids[0]) : reject("ambiguous_identity");
      const local = [...scope.querySelectorAll(MARKERS)].filter(identityAllowed);
      const localPortals = [...scope.querySelectorAll(`[${PORTAL}]`)].filter(identityAllowed);
      const readings = local.map(identities);
      // A shared multi-composer ancestor cannot assign its children's marker
      // to an unlabelled sibling composer.
      if (others.length) return reject("shared_composer_scope");
      if (readings.some(reading => reading.blocked || reading.invalid)) return reject("foreign_or_invalid_identity");
      const ids = [...new Set(readings.flatMap(reading => reading.ids))];
      if (ids.length) return ids.length === 1 ? bound(ids[0]) : reject("ambiguous_identity");
      if ((local.length || localPortals.length) && ownCodexInput) return draft();
    }
    return ownCodexInput ? draft() : reject("unidentified_composer");
  }

  function composersNow() {
    const result = [];
    for (const input of document.querySelectorAll(EDITABLE)) {
      if (!visible(input)) continue;
      const ancestors = [];
      for (let node = input.parentElement; node && node !== document.body; node = node.parentElement) ancestors.push(node);
      // Distance wins over selector type: an outer chrome may also contain a
      // separate side-chat composer. Input-only wrappers are not composers.
      const composer = ancestors.find(node => SELECTORS.some(selector => node.matches(selector))
        && node.querySelector('button,[role="button"]'));
      if (!composer || !visible(composer) || result.includes(composer)) continue;
      // Do not put a full-width block in a single horizontal control row.
      const style = getComputedStyle(composer);
      if (style.display.includes("flex") && style.flexDirection === "row" && style.flexWrap === "nowrap") continue;
      result.push(composer);
    }
    return result;
  }

  const icon = kind => kind === "speed"
    ? '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 10a5.5 5.5 0 0 1 11 0M7 9l3-3M2 8l1 .4M11 8l1-.4"/><circle cx="7" cy="9" r=".6"/></svg>'
    : '<svg viewBox="0 0 14 14" aria-hidden="true"><ellipse cx="7" cy="3.2" rx="4.2" ry="1.7"/><path d="M2.8 3.2v7.6c0 2.2 8.4 2.2 8.4 0V3.2M2.8 6.9c0 2.2 8.4 2.2 8.4 0"/></svg>';

  function placementFor(composer, composers) {
    const footer = composer.closest(STABLE_FOOTER);
    if (!footer) {
      // The new-chat home composer has the same three-part controls row but
      // no thread-scroll footer. Its dedicated relative wrapper is outside
      // React's composer body and provides the equivalent overlay anchor.
      const row = composer.querySelector(FOOTER_ROW);
      const children = row ? [...row.children] : [];
      const input = children.find(node => String(node.className).includes("AdaptiveFooterInput"));
      const sides = children.filter(node => node !== input && node.querySelector('button,[role="button"]'));
      const wrapper = composer.parentElement;
      if (input && children.length === 3 && sides.length === 2 && wrapper
        && wrapper !== document.body && wrapper !== document.documentElement
        && getComputedStyle(wrapper).position !== "static"
        && composers.filter(other => wrapper.contains(other)).length === 1) {
        return { anchor: wrapper, container: wrapper, stable: true };
      }
      return { anchor: composer, container: null, stable: false };
    }
    const sharing = composers.filter(other => other.closest(STABLE_FOOTER) === footer);
    if (sharing.length === 1) return { anchor: footer, container: footer, stable: true };
    let lane = composer;
    while (lane.parentElement && lane.parentElement !== footer) lane = lane.parentElement;
    if (lane !== composer && sharing.filter(other => lane.contains(other)).length === 1) {
      return { anchor: lane, container: footer, stable: true };
    }
    // A shared footer without a distinct lane cannot safely retain an identity.
    return { anchor: composer, container: null, stable: false };
  }

  function ensureLayoutStyle() {
    if (layoutStyle?.isConnected) return;
    layoutStyle = document.createElement("style");
    layoutStyle.dataset.codexInlineLayoutStyle = "1";
    layoutStyle.textContent = `
      [data-codex-inline-footer-layout]{display:grid!important;grid-template-columns:auto minmax(0,1fr)!important;grid-template-rows:auto minmax(var(--codex-inline-row-height,32px),auto)!important;align-items:center!important}
      [data-codex-inline-footer-layout]>[data-codex-inline-footer-slot="input"]{grid-row:1!important;grid-column:1/-1!important;min-width:0!important}
      [data-codex-inline-footer-layout]>[data-codex-inline-footer-slot="left"]{grid-row:2!important;grid-column:1!important;justify-self:start!important}
      [data-codex-inline-footer-layout]>[data-codex-inline-footer-slot="right"]{grid-row:2!important;grid-column:2!important;justify-self:stretch!important}
    `;
    (document.head || document.documentElement).append(layoutStyle);
  }

  function releaseLayout(entry) {
    if (!entry.layout) return;
    const { row, parts, previousHeight } = entry.layout;
    if (row.getAttribute("data-codex-inline-footer-layout") === entry.mountId) {
      row.removeAttribute("data-codex-inline-footer-layout");
      if (previousHeight) row.style.setProperty("--codex-inline-row-height", previousHeight);
      else row.style.removeProperty("--codex-inline-row-height");
      for (const [node, role] of parts) if (node.getAttribute("data-codex-inline-footer-slot") === role) node.removeAttribute("data-codex-inline-footer-slot");
    }
    entry.layout = null;
  }

  function controlsFor(entry) {
    const row = entry.composer?.querySelector(FOOTER_ROW);
    if (!row || !visible(row)) { releaseLayout(entry); return null; }
    const children = [...row.children];
    const input = children.find(node => String(node.className).includes("AdaptiveFooterInput"));
    const sides = children.filter(node => node !== input && node.querySelector('button,[role="button"]'));
    if (!input || children.length !== 3 || sides.length !== 2) { releaseLayout(entry); return null; }
    const [left, right] = sides;
    ensureLayoutStyle();
    if (entry.layout?.row !== row || entry.layout.parts[0][0] !== input || entry.layout.parts[1][0] !== left || entry.layout.parts[2][0] !== right) {
      releaseLayout(entry);
      entry.layout = { row, parts: [[input, "input"], [left, "left"], [right, "right"]], previousHeight: row.style.getPropertyValue("--codex-inline-row-height") };
      row.setAttribute("data-codex-inline-footer-layout", entry.mountId);
      for (const [node, role] of entry.layout.parts) node.setAttribute("data-codex-inline-footer-slot", role);
    }
    return { row, left, right };
  }

  function setStyle(node, name, value) { if (node.style[name] !== value) node.style[name] = value; }

  function buttonBounds(group) {
    const nodes = [...group.querySelectorAll('button,[role="button"]')];
    if (group.matches('button,[role="button"]')) nodes.unshift(group);
    const boxes = nodes.filter(visible).map(node => node.getBoundingClientRect());
    if (!boxes.length) return null;
    return {
      left: Math.min(...boxes.map(box => box.left)), right: Math.max(...boxes.map(box => box.right)),
      top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom)),
    };
  }

  function stackingLevel(node, container) {
    let maximum = 0;
    for (let current = node; current && current !== container; current = current.parentElement) {
      const value = Number(getComputedStyle(current).zIndex);
      if (Number.isFinite(value)) maximum = Math.max(maximum, value);
    }
    return String(maximum + 1);
  }

  function place(entry) {
    if (!entry.stable || entry.suspended || !entry.composer?.isConnected) return;
    const controls = controlsFor(entry);
    setStyle(entry.host, "zIndex", stackingLevel(controls?.row || entry.composer, entry.container));
    const coordinateSpace = entry.host.offsetParent || entry.container;
    const parent = coordinateSpace.getBoundingClientRect();
    if (!controls) {
      if (entry.hasControlPlacement) return;
      // Older layouts retain the safe below-composer placement.
      const box = entry.composer.getBoundingClientRect();
      setStyle(entry.host, "left", `${box.left - parent.left + coordinateSpace.scrollLeft - coordinateSpace.clientLeft}px`);
      setStyle(entry.host, "top", `${box.bottom - parent.top + coordinateSpace.scrollTop - coordinateSpace.clientTop + 4}px`);
      setStyle(entry.host, "width", `${box.width}px`);
      setStyle(entry.host, "visibility", "visible");
      return;
    }
    let leftBox = buttonBounds(controls.left);
    let rightBox = buttonBounds(controls.right);
    if (!leftBox || !rightBox) return;
    // The user prefers a small optical correction toward the lighter left
    // controls: 16 CSS pixels left of the card center, not the whole gap center.
    const composerBox = entry.composer.getBoundingClientRect();
    const center = (composerBox.left + composerBox.right) / 2 - 16;
    const width = Math.floor(2 * Math.min(center - leftBox.right - 8, rightBox.left - center - 8));
    if (width <= 0) { setStyle(entry.host, "visibility", "hidden"); return; }
    setStyle(entry.host, "width", `${width}px`);
    const minimumWidth = Math.max(...[...entry.shadow.querySelectorAll(".metric")].map(node => node.scrollWidth)) + 16;
    if (minimumWidth > width) { setStyle(entry.host, "visibility", "hidden"); return; }
    const height = Math.max(26, entry.host.getBoundingClientRect().height);
    const rowHeight = `${Math.ceil(height)}px`;
    if (controls.row.style.getPropertyValue("--codex-inline-row-height") !== rowHeight) controls.row.style.setProperty("--codex-inline-row-height", rowHeight);
    // The row may grow to fit a compact wrapped metric; read its controls again.
    leftBox = buttonBounds(controls.left); rightBox = buttonBounds(controls.right);
    if (!leftBox || !rightBox) return;
    const centerY = (Math.min(leftBox.top, rightBox.top) + Math.max(leftBox.bottom, rightBox.bottom)) / 2;
    setStyle(entry.host, "left", `${center - width / 2 - parent.left + coordinateSpace.scrollLeft - coordinateSpace.clientLeft}px`);
    setStyle(entry.host, "top", `${centerY - height / 2 - parent.top + coordinateSpace.scrollTop - coordinateSpace.clientTop}px`);
    setStyle(entry.host, "visibility", "visible");
    entry.hasControlPlacement = true;
  }

  function syncResizeTargets() {
    if (!resizeObserver) return;
    const current = new Set();
    for (const entry of bindings.values()) if (entry.stable) {
      for (const node of [entry.container, entry.composer, entry.host, entry.layout?.row, ...(entry.layout?.parts.map(([node]) => node) || [])]) if (node?.isConnected) current.add(node);
    }
    for (const node of observed) if (!current.has(node)) { resizeObserver.unobserve(node); observed.delete(node); }
    for (const node of current) if (!observed.has(node)) { resizeObserver.observe(node); observed.add(node); }
  }

  function layoutAll() {
    if (!active || !document?.documentElement) return;
    for (const entry of bindings.values()) place(entry);
    syncResizeTargets();
  }

  function scheduleLayout() {
    if (!active || layoutQueued) return;
    layoutQueued = true;
    const run = () => { layoutQueued = false; layoutFrame = null; layoutAll(); };
    if (typeof requestAnimationFrame === "function") layoutFrame = requestAnimationFrame(run);
    else Promise.resolve().then(run);
  }

  function mount(composer, threadId, placement) {
    const host = document.createElement("div");
    host.dataset.codexInlineStatus = "1";
    host.style.cssText = placement.stable
      ? "display:block;position:absolute;box-sizing:border-box;min-width:0;overflow:hidden;pointer-events:none;z-index:1;"
      : "display:block;position:relative;box-sizing:border-box;width:100%;min-width:0;flex:0 0 auto;grid-column:1/-1;align-self:stretch;margin-top:4px;clear:both;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{font-family:inherit;color:inherit;contain:style}
      .bar{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;gap:14px;flex-wrap:wrap;min-height:26px;padding:3px 8px;background:transparent;color:var(--text-tertiary,var(--color-text-tertiary,#858991));font-family:inherit;font-size:12px;font-weight:400;line-height:20px;font-variant-numeric:tabular-nums;user-select:none}
      .metric{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;pointer-events:auto}
      .metric>span{display:block}
      svg{display:block;width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}
    </style><div class="bar" role="group" aria-label="Codex 对话用量状态"><span class="metric" data-metric="speed">${icon("speed")}<span>— tok/s</span></span><span class="metric" data-metric="cache">${icon("cache")}<span>缓存命中 —</span></span></div>`;
    const mountId = `composer-${++serial}`;
    const entry = { ...placement, composer, threadId, host, shadow, key: mountId, mountId, hasMetrics: false, issue: null, dataUnavailable: false, watchdog: null, gapTimer: null, gapExpired: false, suspended: false, layout: null };
    if (placement.stable) placement.container.append(host);
    else composer.insertAdjacentElement("afterend", host);
    if (!restoreReading(entry)) render(entry, threadId ? {} : { issue: "awaiting_thread" });
    place(entry);
    return entry;
  }

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }

  function ratio(value) {
    const n = number(value);
    return n !== null && n <= 1 ? n : null;
  }

  function cachePercent(value) {
    if (value === 1) return "100.0%";
    for (let places = 1; places <= 10; places++) {
      const rounded = (value * 100).toFixed(places);
      if (Number(rounded) < 100) return `${rounded}%`;
    }
    return "<100%";
  }

  function render(entry, metrics) {
    entry.cached = false;
    const issue = typeof metrics.issue === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(metrics.issue) ? metrics.issue : null;
    entry.issue = issue;
    const cacheIssue = typeof metrics.cache_issue === "string" ? metrics.cache_issue : null;
    const isVisibleStream = metrics.measurement_method === "visible_stream";
    entry.dataUnavailable = DATA_UNAVAILABLE.has(issue) || DATA_UNAVAILABLE.has(cacheIssue);
    const tps = isVisibleStream ? number(metrics.tps)
      : entry.dataUnavailable || metrics.measurement_method !== "turn_elapsed" ? null : number(metrics.tps);
    const cache = entry.dataUnavailable ? null : ratio(metrics.cache_hit);
    const speed = entry.shadow.querySelector('[data-metric="speed"]');
    const cacheNode = entry.shadow.querySelector('[data-metric="cache"]');
    speed.lastElementChild.textContent = tps === null ? "— tok/s" : `≈${Math.round(tps).toLocaleString("en-US")} tok/s`;
    cacheNode.lastElementChild.textContent = cache === null ? "缓存命中 —" : `缓存命中 ${cachePercent(cache)}`;
    const samples = number(metrics.measured_samples);
    const tokens = number(metrics.measured_tokens);
    const seconds = number(metrics.measured_seconds);
    speed.title = isVisibleStream
      ? "可见文本流式速度：仅统计当前窗口收到的正文文字，按 o200k_base 本地分词。扣除首批已到达文字，以后续文字 token 数 ÷ 首末正文片段接收间隔计算；不包含隐藏推理、工具执行或首字等待。正在输出时显示当前消息，完成后显示本次监测保留消息的加权平均。受网络和客户端批量投递影响，不等于模型或服务器解码速度，也不等于账单 token。"
      : "整轮有效平均（包含等待和工具执行）：依据本机会话日志估算的当前对话已采样完成轮次加权平均：总输出 token ÷ 总整轮耗时，包含等待、推理和工具执行。不是服务端实时测速，也不保证覆盖完整会话；不能用于判断模型真实解码速度。";
    if (samples !== null && tokens !== null && seconds !== null) speed.title += `\n${samples} 个样本；${tokens} tokens / ${seconds.toFixed(3)} 秒。`;
    if (metrics.samples_limited) speed.title += "\n采样条数已限制，仅汇总保留的最近样本。";
    const issues = {
      capacity_exceeded: "同时监测对话已达 32 个上限；关闭部分对话后会恢复。",
      metrics_unavailable: "本机统计后台暂不可用。",
      metrics_timeout: "本机统计后台暂未响应。",
      ownership_unverified: "缺少可核实的会话归属，暂不采用这段日志。",
      inherited_history: "继承日志的归属尚未确认，暂不采用。",
      state_unavailable: "本机会话索引暂不可读取。",
      source_unavailable: "本机会话日志暂不可读取。",
      logs_unavailable: "本机计时日志暂不可读取。",
      logs_index_unavailable: "本机计时索引暂不可读取。",
      backend_error: "本机统计后台处理失败，等待恢复。",
      no_thread: "当前对话数据暂不可读取。",
      catching_up: "正在读取当前对话的历史记录。",
      logs_catching_up: "正在读取当前对话的计时记录。",
      records_skipped: "部分日志记录不可读取，暂不显示统计。",
      monitor_disconnected: "已超过 15 秒未收到监视器更新，数值已清空。",
      ambiguous_response: "输出计时证据存在冲突，已排除相关样本。",
      awaiting_thread: "新对话正在建立；会话编号和统计就绪后会自动显示。",
      awaiting_composer: "输入区正在重建；恢复可核实的对话后会自动更新。",
    };
    if (issues[issue]) speed.title += `\n${issues[issue]}`;
    if (tps === null) speed.title += isVisibleStream ? "\n尚无完整观察的多片段正文；等待下一段可核实输出。" : "\n暂无可核实的测速数据。";
    cacheNode.title = "当前对话累计缓存输入 token / 累计输入 token。它是 token 占比，不是请求次数命中率。";
    for (const metric of [speed, cacheNode]) metric.setAttribute("aria-label", `${metric.lastElementChild.textContent}。${metric.title}`);
    entry.hasMetrics = tps !== null || cache !== null;
    scheduleLayout();
  }

  function clearWatchdog(entry) {
    if (entry.watchdog !== null) clearTimeout(entry.watchdog);
    entry.watchdog = null;
  }

  function rememberReading(entry, metrics) {
    if (!entry.threadId) return;
    if (DATA_UNAVAILABLE.has(metrics.issue)) { readings.delete(entry.threadId); return; }
    const safe = {};
    for (const name of ['scope','measurement_method','observation_id','state','issue','cache_issue',
      'tps','cache_hit','measured_samples','measured_tokens','measured_seconds','samples_limited']) {
      const value = metrics[name];
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
        || (typeof value === 'string' && value.length <= 128)) safe[name] = value;
    }
    // An unfinished text sample may later fail final-text validation. Reuse
    // only its previously completed aggregate when returning to this chat.
    if (metrics.measurement_method === 'visible_stream' && metrics.state === 'provisional') {
      const completed = metrics.completed;
      const valid = number(completed?.measured_samples) > 0 && number(completed?.tps) !== null;
      safe.tps = valid ? completed.tps : null;
      safe.measured_samples = valid ? completed.measured_samples : 0;
      safe.measured_tokens = valid ? completed.tokens : 0;
      safe.measured_seconds = valid ? completed.seconds : 0;
      safe.state = valid ? 'completed' : 'noData';
    }
    if (DATA_UNAVAILABLE.has(safe.cache_issue)) safe.cache_hit = null;
    if (number(safe.tps) === null && ratio(safe.cache_hit) === null) { readings.delete(entry.threadId); return; }
    readings.delete(entry.threadId);
    readings.set(entry.threadId, { metrics: safe, receivedAt: performance.now() });
    while (readings.size > 32) readings.delete(readings.keys().next().value);
  }

  function restoreReading(entry) {
    if (!entry.threadId) return false;
    const cached = readings.get(entry.threadId);
    if (!cached) return false;
    if (cached.metrics.observation_id) {
      let current;
      try { current = window.__CODEX_VISIBLE_STREAM__?.snapshot(entry.threadId)?.observerId; } catch {}
      if (current !== cached.metrics.observation_id) { readings.delete(entry.threadId); return false; }
    }
    readings.delete(entry.threadId); readings.set(entry.threadId, cached);
    render(entry, cached.metrics);
    entry.cached = true;
    const age = Math.max(0, (performance.now() - cached.receivedAt) / 1000);
    for (const metric of entry.shadow.querySelectorAll('.metric')) {
      metric.title += `\n显示本窗口上次统计（${age.toFixed(1)} 秒前收到，已确认），正在后台刷新。`;
      metric.setAttribute('aria-label', `${metric.lastElementChild.textContent}。${metric.title}`);
    }
    armWatchdog(entry);
    return true;
  }

  function armWatchdog(entry) {
    clearWatchdog(entry);
    const key = entry.key, threadId = entry.threadId, cached = readings.get(threadId);
    entry.watchdog = setTimeout(() => {
      entry.watchdog = null;
      if (active && bindings.get(entry.anchor) === entry && entry.key === key && entry.threadId === threadId) {
        if (readings.get(threadId) === cached) readings.delete(threadId);
        render(entry, { issue: "monitor_disconnected" });
      }
    }, 15000);
  }

  function clearGap(entry) {
    if (entry.gapTimer !== null) clearTimeout(entry.gapTimer);
    entry.gapTimer = null;
  }

  function drop(entry) {
    clearWatchdog(entry); clearGap(entry); releaseLayout(entry);
    entry.host.remove(); bindings.delete(entry.anchor);
  }

  function changeIdentity(entry, nextId) {
    if (nextId === entry.threadId) return;
    clearWatchdog(entry);
    entry.threadId = nextId;
    entry.key = `composer-${++serial}`;
    if (!restoreReading(entry)) render(entry, nextId ? {} : { issue: "awaiting_thread" });
  }

  function gapIdentity(entry) {
    const nodes = [entry.anchor, ...entry.anchor.querySelectorAll(MARKERS)].filter(identityAllowed);
    const readings = nodes.map(identities);
    if (readings.some(value => value.blocked || value.invalid)) return { reject: true };
    const ids = [...new Set(readings.flatMap(value => value.ids))];
    if (ids.length > 1) return { reject: true };
    return { reject: false, nextId: ids.length ? ids[0] : undefined };
  }

  function discover() {
    if (!active || !document?.documentElement) return [];
    const composers = composersNow();
    const current = new Map();
    for (const composer of composers) {
      const placement = placementFor(composer, composers);
      const value = { ...placement, composer, ...threadFor(composer, composers) };
      if (current.has(placement.anchor)) current.set(placement.anchor, { ...value, kind: "reject" });
      else current.set(placement.anchor, value);
    }
    for (const [anchor, entry] of bindings) {
      const value = current.get(anchor);
      const temporaryUnknown = value?.kind === "reject" && value.reason === "unidentified_composer" && entry.stable;
      if (!allowed(anchor) || (entry.stable && !entry.container?.isConnected) || (value?.kind === "reject" && !temporaryUnknown)) { drop(entry); continue; }
      if (!value || temporaryUnknown) {
        if (!entry.stable) { drop(entry); continue; }
        // A one-lane / multi-lane layout transition replaces ownership; it is
        // not a rendering gap and must not leave an orphaned placeholder.
        const changedLane = [...current.values()].some(next => next.anchor !== anchor && next.container === entry.container);
        if (changedLane) { drop(entry); continue; }
        const identity = gapIdentity(entry);
        if (identity.reject) { drop(entry); continue; }
        if (identity.nextId !== undefined) changeIdentity(entry, identity.nextId);
        entry.suspended = true;
        if (!entry.host.isConnected) entry.container.append(entry.host);
        if (entry.gapTimer === null && !entry.gapExpired) entry.gapTimer = setTimeout(() => {
          entry.gapTimer = null;
          if (active && bindings.get(anchor) === entry && entry.suspended) {
            entry.gapExpired = true;
            clearWatchdog(entry);
            render(entry, { issue: "awaiting_composer" });
          }
        }, GAP_MS);
        continue;
      }
      clearGap(entry);
      entry.gapExpired = false;
      entry.suspended = false;
      if (entry.composer !== value.composer) releaseLayout(entry);
      entry.composer = value.composer;
      changeIdentity(entry, value.threadId);
      if (!entry.host.isConnected) {
        if (entry.stable) entry.container.append(entry.host);
        else entry.composer.insertAdjacentElement("afterend", entry.host);
      } else if (!entry.stable && (entry.host.parentElement !== entry.composer.parentElement || entry.host.previousElementSibling !== entry.composer)) {
        entry.composer.insertAdjacentElement("afterend", entry.host);
      }
    }
    for (const [anchor, value] of current) if (value.kind !== "reject" && !bindings.has(anchor)) {
      bindings.set(anchor, mount(value.composer, value.threadId, value));
    }
    layoutAll();
    return [...bindings.values()].map(({ key, threadId, suspended }) => ({ key, threadId: suspended ? null : threadId }));
  }

  const api = Object.freeze({
    version: "1.3.5",
    discover,
    currentThreadIds() {
      // Streaming can deliver hundreds of events per second. Reuse the
      // identity observer instead of scanning/layouting the DOM per delta.
      const pending = identityObserver?.takeRecords() || [];
      if (pending.length) processIdentityRecords(pending);
      return [...new Set([...bindings.values()].filter(entry => entry.threadId
        && !entry.suspended && entry.composer?.isConnected && entry.host?.isConnected)
        .map(entry => entry.threadId))];
    },
    apply({ key, metrics } = {}) {
      discover();
      const entry = [...bindings.values()].find(value => value.key === key);
      if (!entry) return false;
      if (!entry.threadId || entry.suspended) return false;
      const validScope = metrics?.scope === "sampled_session"
        || (metrics?.scope === "visible_text_client" && metrics?.measurement_method === "visible_stream");
      if (!validScope) { readings.delete(entry.threadId); armWatchdog(entry); render(entry, { issue: metrics?.issue }); return false; }
      rememberReading(entry, metrics);
      armWatchdog(entry);
      render(entry, metrics);
      return true;
    },
    inspect() {
      discover();
      return { active, count: bindings.size, bindings: [...bindings.values()].map(entry => {
        const rect = entry.host.getBoundingClientRect();
        return { attached: entry.host.isConnected, pending: !entry.threadId || entry.suspended, cached: !!entry.cached, hasMetrics: entry.hasMetrics, issue: entry.issue, dataUnavailable: entry.dataUnavailable, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, labels: [...entry.shadow.querySelectorAll(".metric > span")].map(node => node.textContent) };
      }) };
    },
    destroy() {
      active = false;
      identityObserver?.disconnect();
      resizeObserver?.disconnect(); observed.clear();
      window.removeEventListener("resize", scheduleLayout);
      window.removeEventListener("scroll", scheduleLayout, true);
      if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
      layoutQueued = false; layoutFrame = null;
      const count = bindings.size;
      for (const entry of [...bindings.values()]) drop(entry);
      bindings.clear();
      readings.clear();
      layoutStyle?.remove();
      if (window[NAME] === api) delete window[NAME];
      return { removed: count };
    },
  });
  window[NAME] = api;
  const hasIdentity = node => node.nodeType === 1 && (node.matches(`${MARKERS},[${PORTAL}]`) || node.querySelector(`${MARKERS},[${PORTAL}]`));
  const hasComposer = node => node.nodeType === 1 && (node.matches(`${EDITABLE},${STABLE_FOOTER},${FOOTER_ROW}`) || SELECTORS.some(selector => node.matches(selector)) || node.querySelector(EDITABLE));
  const hasOwned = node => node.nodeType === 1 && (node.matches('[data-codex-inline-status],[data-codex-inline-layout-style]') || node.querySelector('[data-codex-inline-status],[data-codex-inline-layout-style]'));
  function processIdentityRecords(records) {
    if (!active || !document?.documentElement) return;
    if (records.some(record => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some(node => hasIdentity(node) || hasComposer(node)) || [...record.removedNodes].some(hasOwned))) discover();
    else if (records.some(record => record.target.nodeType === 1 && record.target.closest(FOOTER_ROW))) scheduleLayout();
  }
  identityObserver = new MutationObserver(processIdentityRecords);
  if (typeof ResizeObserver === "function") resizeObserver = new ResizeObserver(scheduleLayout);
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("scroll", scheduleLayout, true);
  identityObserver.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: [...ATTRS, PORTAL, CODEX_INPUT, "aria-hidden", "inert", "data-app-shell-active-page"],
  });
  discover();
})();
