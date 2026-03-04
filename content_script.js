(function () {
  const DEFAULTS = { enabled: true, limit: 15 };
  const PAGE_HOST_OK = location.hostname === "chatgpt.com";
  if (!PAGE_HOST_OK) return;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  let settings = { ...DEFAULTS };
  let idCounter = 1;
  let observer = null;
  let pendingFrame = false;
  let suppressObserver = false;
  let baselineHeapBytes = null;
  let hideQueue = [];
  let hideQueueScheduled = false;
  let hideQueueTimer = null;
  let observerDebounceTimer = null;
  let lastRelevantMutationAt = 0;

  const records = new Map();
  const forceVisibleUntil = new Map();

  const state = {
    totalMessages: 0,
    hiddenMessages: 0,
    activeMessages: 0,
    removedNodes: 0,
    estimatedLowMB: 0,
    estimatedHighMB: 0,
    heapDeltaMB: null,
    enabled: true,
    limit: DEFAULTS.limit
  };

  const style = document.createElement("style");
  style.textContent = `
    .domlag-placeholder {
      box-sizing: border-box;
      width: 100%;
      border: 1px dashed rgba(118, 118, 118, 0.45);
      border-radius: 10px;
      background: rgba(120, 120, 120, 0.08);
      color: rgba(140, 140, 140, 1);
      font-size: 12px;
      line-height: 1.4;
      padding: 12px 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      min-height: 52px;
    }
    .domlag-placeholder:hover {
      background: rgba(120, 120, 120, 0.16);
    }
  `;
  document.documentElement.appendChild(style);

  function notifyBadge(active) {
    chrome.runtime.sendMessage({ type: "setBadge", active: Boolean(active) });
  }

  function getMessageElements(main) {
    const selectors = [
      "article[data-testid^='conversation-turn-']",
      "main article[data-testid*='conversation-turn']",
      "[data-message-author-role]"
    ];

    let nodes = [];
    for (const selector of selectors) {
      const found = Array.from(main.querySelectorAll(selector));
      if (found.length >= 2) {
        nodes = found;
        break;
      }
    }

    if (nodes.length === 0) {
      nodes = Array.from(main.querySelectorAll("article"));
    }

    const seen = new Set();
    const deduped = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (!node.isConnected || node.closest("aside, nav, header, footer")) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      deduped.push(node);
    }

    return deduped;
  }

  function assignStableIds(messages) {
    for (const el of messages) {
      if (!el.dataset.domlagId) el.dataset.domlagId = String(idCounter++);
      const id = el.dataset.domlagId;
      if (!records.has(id)) {
        records.set(id, {
          id,
          element: el,
          dehydrated: false,
          fragment: null,
          removedNodes: 0,
          placeholder: null,
          height: 0
        });
      } else {
        records.get(id).element = el;
      }
    }
  }

  function cleanupStaleRecords(liveIds) {
    for (const [id, record] of records.entries()) {
      if (liveIds.has(id)) continue;
      if (record.placeholder?.isConnected) record.placeholder.remove();
      records.delete(id);
      forceVisibleUntil.delete(id);
    }
  }

  function makePlaceholder(record) {
    const div = document.createElement("div");
    div.className = "domlag-placeholder";
    div.dataset.domlagPlaceholder = record.id;
    div.style.minHeight = `${Math.max(52, Math.round(record.height || 52))}px`;
    div.textContent = "Message hidden to reduce lag — click to render";
    div.addEventListener("click", () => {
      forceVisibleUntil.set(record.id, Date.now() + 20000);
      hydrate(record);
      scheduleEnforce();
    });
    return div;
  }

  function dehydrate(record) {
    if (!record || record.dehydrated || !record.element || !record.element.isConnected) return;
    const el = record.element;

    record.height = el.getBoundingClientRect().height || el.offsetHeight || 52;
    const topLevelChildren = Math.max(1, el.childElementCount);
    record.removedNodes = topLevelChildren * 10;
    const range = document.createRange();
    range.selectNodeContents(el);

    suppressObserver = true;
    record.fragment = range.extractContents();
    record.placeholder = makePlaceholder(record);
    el.replaceChildren(record.placeholder);
    suppressObserver = false;

    record.dehydrated = true;
  }

  function hydrate(record) {
    if (!record || !record.dehydrated || !record.element || !record.element.isConnected) return;

    suppressObserver = true;
    if (record.fragment) {
      record.element.replaceChildren(record.fragment);
    } else if (record.placeholder?.isConnected) {
      record.placeholder.remove();
    }
    suppressObserver = false;

    record.placeholder = null;
    record.dehydrated = false;
    record.fragment = null;
    record.removedNodes = 0;
  }

  function scheduleHideQueue(delayMs = 0) {
    if (hideQueueScheduled || hideQueueTimer) return;
    if (delayMs > 0) {
      hideQueueTimer = setTimeout(() => {
        hideQueueTimer = null;
        if (hideQueueScheduled) return;
        hideQueueScheduled = true;
        requestAnimationFrame(processHideQueue);
      }, delayMs);
      return;
    }
    hideQueueScheduled = true;
    requestAnimationFrame(processHideQueue);
  }

  function processHideQueue() {
    hideQueueScheduled = false;
    if (hideQueue.length === 0) return;

    if (Date.now() - lastRelevantMutationAt < 600) {
      scheduleHideQueue(140);
      return;
    }

    const batchSize = hideQueue.length > 80 ? 20 : 12;
    let processed = 0;
    while (hideQueue.length > 0 && processed < batchSize) {
      const record = hideQueue.shift();
      if (record) dehydrate(record);
      processed += 1;
    }

    if (hideQueue.length > 0) {
      scheduleHideQueue();
    } else {
      scheduleEnforce();
    }
  }

  function updateStats(messages) {
    let hidden = 0;
    let removedNodes = 0;
    for (const message of messages) {
      const id = message.dataset.domlagId;
      if (!id || !records.has(id)) continue;
      const record = records.get(id);
      if (record.dehydrated) {
        hidden += 1;
        removedNodes += record.removedNodes;
      }
    }

    state.totalMessages = messages.length;
    state.hiddenMessages = hidden;
    state.activeMessages = Math.max(0, messages.length - hidden);
    state.removedNodes = removedNodes;
    state.estimatedLowMB = (removedNodes * 180) / (1024 * 1024);
    state.estimatedHighMB = (removedNodes * 320) / (1024 * 1024);
    state.enabled = settings.enabled;
    state.limit = settings.limit;

    if (performance?.memory?.usedJSHeapSize && baselineHeapBytes) {
      state.heapDeltaMB = Math.max(0, (baselineHeapBytes - performance.memory.usedJSHeapSize) / (1024 * 1024));
    } else {
      state.heapDeltaMB = null;
    }
  }

  function enforceLimit() {
    pendingFrame = false;

    const main = document.querySelector("main");
    if (!main) {
      notifyBadge(false);
      return;
    }

    const messages = getMessageElements(main);
    assignStableIds(messages);
    cleanupStaleRecords(new Set(messages.map((m) => m.dataset.domlagId)));

    if (!settings.enabled) {
      for (const message of messages) {
        const record = records.get(message.dataset.domlagId);
        hydrate(record);
      }
      updateStats(messages);
      notifyBadge(false);
      return;
    }

    const limit = clamp(Number(settings.limit) || DEFAULTS.limit, 3, 200);
    const desired = new Set();
    const start = Math.max(0, messages.length - limit);
    for (let i = start; i < messages.length; i += 1) {
      desired.add(messages[i].dataset.domlagId);
    }

    const now = Date.now();
    for (const [id, expiresAt] of forceVisibleUntil.entries()) {
      if (expiresAt > now) desired.add(id);
      else forceVisibleUntil.delete(id);
    }

    const toHide = [];
    for (const message of messages) {
      const id = message.dataset.domlagId;
      const record = records.get(id);
      if (!record) continue;
      if (desired.has(id)) {
        hydrate(record);
      } else if (!record.dehydrated) {
        toHide.push(record);
      }
    }

    if (toHide.length > 0) {
      hideQueue = toHide;
      scheduleHideQueue();
    }

    updateStats(messages);
    notifyBadge(true);
  }

  function scheduleEnforce() {
    if (pendingFrame) return;
    pendingFrame = true;
    requestAnimationFrame(enforceLimit);
  }

  function scheduleEnforceFromObserver() {
    if (observerDebounceTimer) clearTimeout(observerDebounceTimer);
    observerDebounceTimer = setTimeout(() => {
      observerDebounceTimer = null;
      scheduleEnforce();
    }, 250);
  }

  function nodeLooksLikeMessage(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (
      node.matches("article[data-testid^='conversation-turn-']") ||
      node.matches("main article[data-testid*='conversation-turn']") ||
      node.matches("[data-message-author-role]")
    ) {
      return true;
    }
    return Boolean(
      node.querySelector(
        "article[data-testid^='conversation-turn-'], main article[data-testid*='conversation-turn'], [data-message-author-role]"
      )
    );
  }

  function bindObserver() {
    if (observer) observer.disconnect();
    const main = document.querySelector("main");
    if (!main) return;

    observer = new MutationObserver((mutations) => {
      if (suppressObserver) return;
      let relevant = false;
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        if (
          Array.from(mutation.addedNodes).some(nodeLooksLikeMessage) ||
          Array.from(mutation.removedNodes).some(nodeLooksLikeMessage)
        ) {
          relevant = true;
          break;
        }
      }
      if (!relevant) return;
      lastRelevantMutationAt = Date.now();
      scheduleEnforceFromObserver();
    });

    observer.observe(main, { childList: true, subtree: true });
  }

  function applySettings(next) {
    const newEnabled = typeof next.enabled === "boolean" ? next.enabled : settings.enabled;
    const newLimitRaw = Number(next.limit);
    const newLimit = Number.isFinite(newLimitRaw) ? clamp(Math.round(newLimitRaw), 3, 200) : settings.limit;
    const changed = newEnabled !== settings.enabled || newLimit !== settings.limit;
    settings.enabled = newEnabled;
    settings.limit = newLimit;
    state.enabled = settings.enabled;
    state.limit = settings.limit;
    if (settings.enabled && performance?.memory?.usedJSHeapSize) {
      baselineHeapBytes = performance.memory.usedJSHeapSize;
    }
    if (changed) scheduleEnforce();
  }

  function boot() {
    chrome.storage.sync.get(DEFAULTS, (result) => {
      applySettings(result);
      bindObserver();
      scheduleEnforce();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    const next = {};
    if (changes.enabled) next.enabled = changes.enabled.newValue;
    if (changes.limit) next.limit = changes.limit.newValue;
    if (Object.keys(next).length > 0) applySettings(next);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "getState") {
      sendResponse({
        ...state,
        estimatedText: `~${state.estimatedLowMB.toFixed(1)}-${state.estimatedHighMB.toFixed(1)} MB`
      });
      return;
    }

    if (message.type === "toggleEnabled") {
      const enabled = !settings.enabled;
      chrome.storage.sync.set({ enabled }, () => {
        sendResponse({ enabled });
      });
      return true;
    }

    if (message.type === "updateSettings") {
      const next = {};
      if (typeof message.enabled === "boolean") next.enabled = message.enabled;
      if (typeof message.limit !== "undefined") next.limit = message.limit;
      chrome.storage.sync.set(next, () => sendResponse({ ok: true }));
      return true;
    }
  });

  boot();
})();
