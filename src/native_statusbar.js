/* Local Codex composer status: independent of React and removable at runtime. */
(() => {
  "use strict";
  const NAME = "__CODEX_INLINE_STATUS__";
  const REVISION = "1.3.5-live.7";
  // 监视器另有发现步骤；重复加载同一版脚本不再强制扫描和布局整个输入区。
  if (window[NAME]?.revision === REVISION) return;
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
  const DISPLAY_PREFIX = 'codex-inline-status:display:v1:';
  const READING_FIELDS = ['scope','measurement_method','observation_id','state','issue','cache_issue',
    'tps','cache_hit','measured_samples','measured_tokens','measured_seconds','samples_limited','speed_window_ms','phase',
    'speed_persisted','cache_persisted','speed_saved_at','cache_saved_at','persistence_issue','sample_key','speed_unconfirmed','reading_observer_id'];
  let serial = 0;
  let active = true;
  let identityObserver;
  let resizeObserver;
  let numberResizeObserver;
  const numberTargets = new Map();
  let layoutFrame = null;
  let layoutQueued = false;
  let layoutStyle;
  let identityDirty = false;
  let discoveryQueued = false;
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

  function onScroll(event) {
    // 消息列表滚动通常不会移动固定输入区；只在状态条的滚动祖先变化时重测位置。
    const target = event.target;
    if (target === window || target === document
      || [...bindings.values()].some(entry => target?.contains?.(entry.host))) scheduleLayout();
  }

  function mount(composer, threadId, placement) {
    const host = document.createElement("div");
    host.dataset.codexInlineStatus = "1";
    host.style.cssText = placement.stable
      ? "display:block;position:absolute;box-sizing:border-box;min-width:0;overflow:hidden;pointer-events:none;z-index:1;"
      : "display:block;position:relative;box-sizing:border-box;width:100%;min-width:0;flex:0 0 auto;grid-column:1/-1;align-self:stretch;margin-top:4px;clear:both;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{font-family:inherit;color:inherit;contain:layout style}
      .bar{box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;gap:14px;flex-wrap:wrap;min-height:26px;padding:3px 8px;background:transparent;color:var(--text-tertiary,var(--color-text-tertiary,#858991));font-family:inherit;font-size:12px;font-weight:400;line-height:20px;font-variant-numeric:tabular-nums;user-select:none}
      .metric{display:inline-flex;align-items:center;gap:3px;white-space:nowrap;pointer-events:auto}
      .metric>span{display:block}
      .number-switch{position:relative;display:inline-grid;vertical-align:baseline;white-space:nowrap}
      .number-current{display:inline-grid;grid-area:1/1}
      .number-switch.measured-width{height:20px;vertical-align:bottom;overflow:clip;overflow-clip-margin:3px;transition:width 700ms cubic-bezier(.22,.61,.36,1)}
      .number-switch.measured-width>.number-current{position:absolute;left:0;top:0;width:max-content}
      .number-text{width:max-content}
      .number-text,.number-current::after{grid-area:1/1}
      .number-switch.is-switching::before{position:absolute;inset:0;content:attr(data-previous);pointer-events:none;filter:blur(.8px);will-change:transform,opacity;animation:codex-number-out 700ms cubic-bezier(.22,.61,.36,1) both}
      .number-switch.is-switching>.number-current{will-change:transform;animation:codex-number-in 700ms cubic-bezier(.22,.61,.36,1) both}
      .number-switch.is-switching>.number-current::after{content:attr(data-current);pointer-events:none;filter:blur(1.5px);will-change:opacity;animation:codex-number-unblur 700ms ease-out both}
      .number-switch.is-switching .number-text{will-change:opacity;animation:codex-number-sharpen 700ms ease-out both}
      @keyframes codex-number-out{0%{opacity:1;transform:translate3d(0,0,0)}75%,100%{opacity:0;transform:translate3d(0,-6px,0)}}
      @keyframes codex-number-in{0%{transform:translate3d(0,6px,0)}100%{transform:translate3d(0,0,0)}}
      @keyframes codex-number-unblur{0%{opacity:.85}75%,100%{opacity:0}}
      @keyframes codex-number-sharpen{0%{opacity:0}75%,100%{opacity:1}}
      @media(prefers-reduced-motion:reduce){.number-switch.measured-width{transition:none}.number-switch.is-switching>.number-current,.number-switch.is-switching .number-text{animation:none}.number-switch.is-switching::before,.number-switch.is-switching>.number-current::after{display:none;animation:none}}
      svg{display:block;width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}
    </style><div class="bar" role="group" aria-label="Codex 对话用量状态"><span class="metric" data-metric="speed">${icon("speed")}<span>— tok/s</span></span><span class="metric" data-metric="cache">${icon("cache")}<span>缓存命中 —</span></span></div>`;
    const mountId = `composer-${++serial}`;
    const entry = { ...placement, composer, threadId, host, shadow, key: mountId, mountId, hasMetrics: false, issue: null, dataUnavailable: false, watchdog: null, gapTimer: null, gapExpired: false, suspended: false, layout: null, animationTimers: new Set() };
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

  function setMetricText(entry, label, text) {
    const match = text.match(/^(缓存命中 )?([<]?[\d,.]+|—)( tok\/s|%)?$/);
    // 初始 HTML 已有横线文本，但仍须建立动画容器；结构就绪后同值更新继续零写入。
    if (label.textContent === text && (!match || label.__codexNumberReady)) return;
    let digits = label.querySelector('.number-switch');
    const previous = digits?.textContent;
    // 新值、占位符和身份切换都先撤销旧动效，避免延迟回调清除另一轮数字。
    digits?.__codexNumberCleanup?.();
    if (!match) {
      const target = digits?.querySelector('.number-text');
      if (target) { numberResizeObserver?.unobserve(target); numberTargets.delete(target); }
      label.__codexNumberReady = false; label.textContent = text; return;
    }
    if (!digits) {
      digits = document.createElement('span'); digits.className = 'number-switch';
      const current = document.createElement('span'); current.className = 'number-current';
      const numberText = document.createElement('span'); numberText.className = 'number-text'; current.append(numberText); digits.append(current);
      label.replaceChildren(document.createTextNode(match[1] || ''), digits, document.createTextNode(match[3] || ''));
      label.__codexNumberReady = true;
      if (numberResizeObserver) {
        // 真实字宽由浏览器布局后通过 RO 交付；不按字符数猜宽，也不在数字更新时强制测量。
        // 文字保持独立固有宽度，外层宽度平滑过渡，单位与整组居中位置随之自然移动。
        digits.classList.add('measured-width');
        numberTargets.set(numberText, { digits, entry }); numberResizeObserver.observe(numberText);
      }
    }
    const current = digits.firstElementChild;
    current.firstElementChild.textContent = match[2];
    current.dataset.current = match[2];
    label.firstChild.nodeValue = match[1] || '';
    label.lastChild.nodeValue = match[3] || '';
    // 数字首次出现和实际改变都默认播放；从等待状态恢复时也不能漏掉入场动画。
    // 旧值放在伪元素，不污染读屏、复制和数值核验。
    // 不读取 offsetWidth、不用 JS 逐帧绘制，也不让单位和图标参与模糊。
    // 同一会话的数字和横线双向过渡；归属变化时不留下另一会话的旧数字图层。
    if (!previous || entry.crossingThread || previous === match[2]
      || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    digits.dataset.previous = previous || ''; digits.classList.add('is-switching');
    let timer;
    const cleanup = () => {
      if (digits.__codexNumberCleanup !== cleanup) return;
      digits.classList.remove('is-switching'); delete digits.dataset.previous;
      current.removeEventListener('animationend', onEnd);
      if (timer !== undefined) { clearTimeout(timer); entry.animationTimers.delete(timer); }
      delete digits.__codexNumberCleanup;
    };
    const onEnd = event => { if (event.animationName === 'codex-number-in') cleanup(); };
    current.addEventListener('animationend', onEnd);
    digits.__codexNumberCleanup = cleanup;
    // 隐藏窗口可能不交付 animationend；有界兜底，并在卸载时一起取消。
    timer = setTimeout(cleanup, 850); entry.animationTimers.add(timer);
  }

  function render(entry, metrics) {
    entry.crossingThread = entry.renderedThreadId !== undefined && entry.renderedThreadId !== entry.threadId;
    entry.renderedThreadId = entry.threadId;
    entry.cached = metrics.speed_persisted === true || metrics.cache_persisted === true;
    entry.speedPersisted = metrics.speed_persisted === true;
    entry.cachePersisted = metrics.cache_persisted === true;
    const issue = typeof metrics.issue === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(metrics.issue) ? metrics.issue : null;
    entry.issue = issue;
    const cacheIssue = typeof metrics.cache_issue === "string" ? metrics.cache_issue : null;
    const isVisibleStream = metrics.measurement_method === "visible_stream";
    entry.metricState = typeof metrics.state === "string" ? metrics.state : null;
    entry.phase = typeof metrics.phase === "string" ? metrics.phase : null;
    entry.receivedAtMs = performance.now();
    entry.dataUnavailable = DATA_UNAVAILABLE.has(issue) || DATA_UNAVAILABLE.has(cacheIssue);
    const tps = isVisibleStream ? number(metrics.tps)
      : entry.dataUnavailable || metrics.measurement_method !== "turn_elapsed" ? null : number(metrics.tps);
    const cache = entry.dataUnavailable && !entry.cachePersisted ? null : ratio(metrics.cache_hit);
    const speed = entry.shadow.querySelector('[data-metric="speed"]');
    const cacheNode = entry.shadow.querySelector('[data-metric="cache"]');
    const phaseText = { thinking: "思考中", tool: "工具执行中", waiting: "等待正文", output: "等待正文" };
    const speedText = tps === null || tps === 0 ? "— tok/s" : tps < 1 ? "<1 tok/s" : `${Math.round(tps).toLocaleString("en-US")} tok/s`;
    const cacheText = cache === null ? "缓存命中 —" : `缓存命中 ${cachePercent(cache)}`;
    // 相同读数仍需续期看门狗，但无需重建文本节点或再次触发布局观察器。
    const layoutChanged = speed.lastElementChild.textContent !== speedText || cacheNode.lastElementChild.textContent !== cacheText;
    setMetricText(entry, speed.lastElementChild, speedText);
    setMetricText(entry, cacheNode.lastElementChild, cacheText);
    const samples = number(metrics.measured_samples);
    const tokens = number(metrics.measured_tokens);
    const seconds = number(metrics.measured_seconds);
    let speedTitle = isVisibleStream
      ? "可见文本流式速度：仅统计当前窗口收到的正文文字，按 o200k_base 本地分词。扣除首批已到达文字；不包含隐藏推理、工具执行或首字等待。每 5 秒采样，有新正文时更新最近采样区间的正文 token 增量速度；暂停、思考和工具执行期间保留最近一次有效读数，不归零。尚无有效样本时显示破折号。完成后显示最近一段已核实回复的平均速度，不使用跨轮次历史平均。受网络和客户端批量投递影响，不等于模型或服务器解码速度，也不等于账单 token。"
      : "整轮有效平均（包含等待和工具执行）：依据本机会话日志估算的当前对话已采样完成轮次加权平均：总输出 token ÷ 总整轮耗时，包含等待、推理和工具执行。不是服务端实时测速，也不保证覆盖完整会话；不能用于判断模型真实解码速度。";
    if (samples !== null && tokens !== null && seconds !== null) speedTitle += `\n${samples} 个样本；${tokens} tokens / ${seconds.toFixed(3)} 秒。`;
    if (metrics.samples_limited) speedTitle += "\n采样条数已限制，仅汇总保留的最近样本。";
    const savedTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0
      ? new Date(value * 1000).toLocaleString() : '未知时间';
    if (entry.speedPersisted) speedTitle = `本会话上次保存的已确认速度（${savedTime(metrics.speed_saved_at)}），等待新的有效采样。此值不是当前窗口的新测速。\n${speedTitle}`;
    if (entry.speedPersisted && metrics.speed_unconfirmed) speedTitle = `本会话上次显示的采样速度（${savedTime(metrics.speed_saved_at)}），当时回复尚未完成核对；仅恢复显示，不作为当前窗口的新测速。\n${speedTitle.replace(/^本会话上次保存的已确认速度[^\n]*\n/, '')}`;
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
    if (issues[issue]) speedTitle += `\n${issues[issue]}`;
    if (metrics.state === "waiting") speedTitle += `\n当前阶段：${phaseText[metrics.phase] || "等待正文"}，本区间没有新正文。`;
    if (tps === null) speedTitle += isVisibleStream ? "\n尚无完整观察的多片段正文；等待下一段可核实输出。" : "\n暂无可核实的测速数据。";
    let cacheTitle = "当前对话累计缓存输入 token / 累计输入 token。它是 token 占比，不是请求次数命中率。";
    if (entry.cachePersisted) cacheTitle = `本会话上次保存的缓存命中率（${savedTime(metrics.cache_saved_at)}），本机日志就绪后更新。\n${cacheTitle}`;
    if (metrics.persistence_issue) {
      const warning = '\n会话统计暂时无法读取或保存；当前采样仍继续，后续会重试保存。';
      speedTitle += warning; cacheTitle += warning;
    }
    if (speed.title !== speedTitle) speed.title = speedTitle;
    if (cacheNode.title !== cacheTitle) cacheNode.title = cacheTitle;
    for (const metric of [speed, cacheNode]) {
      const label = `${metric.lastElementChild.textContent}。${metric.title}`;
      if (metric.getAttribute("aria-label") !== label) metric.setAttribute("aria-label", label);
    }
    entry.hasMetrics = tps !== null || cache !== null;
    // 数字宽度变化由 ResizeObserver 感知；字符变化本身不应让整行重新测量。
    if (layoutChanged && !resizeObserver) scheduleLayout();
  }

  function clearWatchdog(entry) {
    if (entry.watchdog !== null) clearTimeout(entry.watchdog);
    entry.watchdog = null;
  }

  function safeReading(metrics) {
    const safe = {};
    for (const name of READING_FIELDS) {
      const value = metrics[name];
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
        || (typeof value === 'string' && value.length <= 1024)) safe[name] = value;
    }
    return safe;
  }

  function forgetReading(threadId) {
    readings.delete(threadId);
    try { window.localStorage.removeItem(DISPLAY_PREFIX + threadId); } catch {}
  }

  function storedReading(threadId) {
    const hot = readings.get(threadId);
    if (hot) return hot;
    // 只同步读取本插件、当前 UUID 的小型数值镜像，不遍历应用存储或访问聊天内容。
    // 原生 JSON 仍保存已确认统计；此镜像另记上次显示值，避免路由重建或热缓存淘汰后闪横线。
    try {
      const raw = window.localStorage.getItem(DISPLAY_PREFIX + threadId);
      if (!raw || raw.length > 4096) return null;
      const value = JSON.parse(raw), m = value.metrics;
      if (value.schemaVersion !== 1 || value.threadId !== threadId || !m
        || m.scope !== 'visible_text_client' || m.measurement_method !== 'visible_stream'
        || !(value.savedAt > 0) || value.savedAt > Date.now() + 300000
        || (!(number(m.tps) > 0) && ratio(m.cache_hit) === null)) return null;
      return { metrics: safeReading(m), receivedAt: performance.now(), savedAt: value.savedAt };
    } catch { return null; }
  }

  function historicalReading(cached) {
    const safe = { ...cached.metrics, state: 'saved' };
    if (number(safe.tps) > 0) { safe.speed_persisted = true; safe.speed_saved_at ??= cached.savedAt / 1000; }
    if (ratio(safe.cache_hit) !== null) { safe.cache_persisted = true; safe.cache_saved_at ??= cached.savedAt / 1000; }
    return safe;
  }

  function retainDisplay(entry, metrics) {
    const cached = storedReading(entry.threadId);
    if (!cached || DATA_UNAVAILABLE.has(metrics.issue)) return metrics;
    const revoked = metrics.observation_id === (cached.metrics.reading_observer_id ?? cached.metrics.observation_id)
      && Array.isArray(metrics.invalidated_keys) && metrics.invalidated_keys.includes(cached.metrics.sample_key)
      && !(metrics.interrupted_keys || []).includes(cached.metrics.sample_key);
    if (revoked) { forgetReading(entry.threadId); return metrics; }
    // 暂无新样本与“旧样本无效”是两种状态。前者保留历史显示，后者必须立即撤销。
    if (metrics.measurement_method !== 'visible_stream' || (metrics.state !== 'noData' && metrics.state !== 'saved')) return metrics;
    const old = historicalReading(cached), next = { ...metrics };
    if (!(number(next.tps) > 0) && number(old.tps) > 0) {
      for (const field of ['tps','measured_samples','measured_tokens','measured_seconds','speed_persisted','speed_saved_at','speed_unconfirmed','sample_key','reading_observer_id']) next[field] = old[field];
      next.state = 'saved';
    }
    if (ratio(next.cache_hit) === null && ratio(old.cache_hit) !== null
      && (!DATA_UNAVAILABLE.has(metrics.cache_issue) || ['catching_up','logs_catching_up'].includes(metrics.cache_issue))) {
      next.cache_hit = old.cache_hit; next.cache_persisted = true; next.cache_saved_at = old.cache_saved_at;
    }
    return next;
  }

  function rememberReading(entry, metrics) {
    if (!entry.threadId) return;
    if (DATA_UNAVAILABLE.has(metrics.issue)) { forgetReading(entry.threadId); return; }
    const safe = safeReading(metrics);
    safe.reading_observer_id ??= metrics.observation_id;
    // 展示快照与计量状态分开：切回可回显采样值，但不能把未完成正文冒充已确认回复。
    if (metrics.measurement_method === 'visible_stream' && metrics.state === 'provisional') {
      safe.speed_unconfirmed = true;
    }
    if (DATA_UNAVAILABLE.has(safe.cache_issue) && !safe.cache_persisted) safe.cache_hit = null;
    if (!(number(safe.tps) > 0) && ratio(safe.cache_hit) === null) { forgetReading(entry.threadId); return; }
    const previous = readings.get(entry.threadId);
    const unchanged = previous && JSON.stringify(previous.metrics) === JSON.stringify(safe);
    const savedAt = unchanged ? previous.savedAt : Date.now();
    readings.delete(entry.threadId);
    readings.set(entry.threadId, { metrics: safe, receivedAt: performance.now(), savedAt });
    if (!unchanged && safe.scope === 'visible_text_client') {
      try { window.localStorage.setItem(DISPLAY_PREFIX + entry.threadId, JSON.stringify({schemaVersion:1,threadId:entry.threadId,savedAt,metrics:safe})); } catch {}
    }
    while (readings.size > 32) readings.delete(readings.keys().next().value);
  }

  function restoreReading(entry) {
    if (!entry.threadId) return false;
    const cached = storedReading(entry.threadId);
    if (!cached) return false;
    readings.delete(entry.threadId); readings.set(entry.threadId, cached);
    while (readings.size > 32) readings.delete(readings.keys().next().value);
    render(entry, historicalReading(cached));
    entry.cached = true;
    const age = Math.max(0, (performance.now() - cached.receivedAt) / 1000);
    for (const metric of entry.shadow.querySelectorAll('.metric')) {
      metric.title += `\n显示本会话上次统计（${age.toFixed(1)} 秒前收到），正在后台刷新。`;
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
        if (readings.get(threadId) === cached) forgetReading(threadId);
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
    for (const digits of entry.shadow.querySelectorAll('.number-switch')) digits.__codexNumberCleanup?.();
    for (const timer of entry.animationTimers) clearTimeout(timer);
    entry.animationTimers.clear();
    for (const [target, value] of numberTargets) if (value.entry === entry) {
      numberResizeObserver?.unobserve(target); numberTargets.delete(target);
    }
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
    identityDirty = false;
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
    syncResizeTargets();
    scheduleLayout();
    return [...bindings.values()].map(({ key, threadId, suspended }) => ({ key, threadId: suspended ? null : threadId }));
  }

  function currentBindings() {
    // 先同步处理尚未交付的身份变更，防止路由刚切换时把旧读数套到新对话。
    const pending = identityObserver?.takeRecords() || [];
    if (pending.length) processIdentityRecords(pending, false);
    if (identityDirty) discover();
    return [...bindings.values()].map(entry => ({ key: entry.key,
      threadId: !entry.suspended && entry.composer?.isConnected && entry.host?.isConnected ? entry.threadId : null }));
  }

  const api = Object.freeze({
    version: "1.3.5",
    revision: REVISION,
    discover,
    bindings: currentBindings,
    currentThreadIds() {
      // Streaming can deliver hundreds of events per second. Reuse the
      // identity observer instead of scanning/layouting the DOM per delta.
      return [...new Set(currentBindings().map(view => view.threadId).filter(Boolean))];
    },
    apply({ key, metrics } = {}) {
      currentBindings();
      const entry = [...bindings.values()].find(value => value.key === key);
      if (!entry) return false;
      if (!entry.threadId || entry.suspended) return false;
      const validScope = metrics?.scope === "sampled_session"
        || (metrics?.scope === "visible_text_client" && metrics?.measurement_method === "visible_stream");
      if (!validScope) { forgetReading(entry.threadId); armWatchdog(entry); render(entry, { issue: metrics?.issue }); return false; }
      metrics = retainDisplay(entry, metrics);
      rememberReading(entry, metrics);
      armWatchdog(entry);
      render(entry, metrics);
      return true;
    },
    inspect({ refresh = true, geometry = true } = {}) {
      // 同一轮轮询已完成发现和更新时，健康报告直接读取现有绑定。
      if (refresh) discover();
      return { active, count: bindings.size, bindings: [...bindings.values()].map(entry => {
        const box = geometry ? entry.host.getBoundingClientRect() : null;
        return { attached: entry.host.isConnected, pending: !entry.threadId || entry.suspended, cached: !!entry.cached, hasMetrics: entry.hasMetrics, issue: entry.issue, dataUnavailable: entry.dataUnavailable,
          state: entry.metricState ?? null, phase: entry.phase ?? null, updatedAtMs: entry.receivedAtMs ?? null,
          speedPersisted: !!entry.speedPersisted, cachePersisted: !!entry.cachePersisted,
          ...(box ? { rect: { x: box.x, y: box.y, width: box.width, height: box.height } } : {}),
          labels: [...entry.shadow.querySelectorAll(".metric > span")].map(node => node.textContent) };
      }) };
    },
    destroy() {
      active = false;
      identityObserver?.disconnect();
      resizeObserver?.disconnect(); observed.clear();
      numberResizeObserver?.disconnect(); numberTargets.clear();
      window.removeEventListener("resize", scheduleLayout);
      window.removeEventListener("scroll", onScroll, true);
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
  function relevantAttribute(record) {
    if (record.type !== "attributes") return false;
    if ([...ATTRS, PORTAL, CODEX_INPUT].includes(record.attributeName)) return true;
    return [...bindings.values()].some(entry => record.target.contains(entry.composer) || record.target === entry.anchor)
      || hasComposer(record.target);
  }
  function processIdentityRecords(records, schedule = true) {
    if (!active || !document?.documentElement) return;
    if (records.some(record => relevantAttribute(record) || [...record.addedNodes, ...record.removedNodes].some(node => hasIdentity(node) || hasComposer(node)) || [...record.removedNodes].some(hasOwned))) {
      identityDirty = true;
      if (schedule && !discoveryQueued) {
        discoveryQueued = true;
        Promise.resolve().then(() => {
          discoveryQueued = false;
          if (!active || !identityDirty) return;
          discover();
          try { window.__codexInlineNotify?.("identity"); } catch {}
        });
      }
    }
    else if (records.some(record => record.target.nodeType === 1 && record.target.closest(FOOTER_ROW))) scheduleLayout();
  }
  identityObserver = new MutationObserver(processIdentityRecords);
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(scheduleLayout);
    numberResizeObserver = new ResizeObserver(entries => {
      if (!active) return;
      for (const reading of entries) {
        const value = numberTargets.get(reading.target);
        const box = Array.isArray(reading.contentBoxSize) ? reading.contentBoxSize[0] : reading.contentBoxSize;
        const width = box?.inlineSize ?? reading.contentRect?.width;
        if (value?.digits.isConnected && Number.isFinite(width) && width > 0) setStyle(value.digits, 'width', `${width}px`);
      }
    });
  }
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("scroll", onScroll, true);
  identityObserver.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    // 应用也可能用 class/style 隐藏旧页面；必须撤销其绑定，不能只依赖节点是否仍在 DOM 中。
    attributeFilter: [...ATTRS, PORTAL, CODEX_INPUT, "aria-hidden", "inert", "hidden", "class", "style", "data-app-shell-active-page"],
  });
  discover();
})();
