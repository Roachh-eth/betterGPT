const DEFAULTS = {
  enabled: true,
  limit: 15
};

const enabledToggle = document.getElementById("enabledToggle");
const limitRange = document.getElementById("limitRange");
const limitValue = document.getElementById("limitValue");
const hiddenCount = document.getElementById("hiddenCount");
const activeCount = document.getElementById("activeCount");
const removedNodes = document.getElementById("removedNodes");
const memEstimate = document.getElementById("memEstimate");
const heapRow = document.getElementById("heapRow");
const heapDelta = document.getElementById("heapDelta");

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

function sendToContent(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response ?? null);
    });
  });
}

function setStats(stats) {
  hiddenCount.textContent = String(stats?.hiddenMessages ?? 0);
  activeCount.textContent = String(stats?.activeMessages ?? 0);
  removedNodes.textContent = String(stats?.removedNodes ?? 0);
  memEstimate.textContent = stats?.estimatedText || "~0.0-0.0 MB";
  if (typeof stats?.heapDeltaMB === "number") {
    heapRow.classList.remove("hidden");
    heapDelta.textContent = `${stats.heapDeltaMB.toFixed(1)} MB`;
  } else {
    heapRow.classList.add("hidden");
  }
}

function applySettingsUI(settings) {
  enabledToggle.checked = Boolean(settings.enabled);
  const limit = Number.isFinite(Number(settings.limit)) ? Number(settings.limit) : DEFAULTS.limit;
  limitRange.value = String(limit);
  limitValue.textContent = String(limit);
}

async function persistSettings(next) {
  chrome.storage.sync.set(next);
  const tab = await getActiveTab();
  if (!tab?.id) return;
  await sendToContent(tab.id, { type: "updateSettings", ...next });
}

async function refreshStats() {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
    setStats(null);
    return;
  }
  const stats = await sendToContent(tab.id, { type: "getState" });
  setStats(stats);
}

enabledToggle.addEventListener("change", async () => {
  await persistSettings({ enabled: enabledToggle.checked });
  refreshStats();
});

limitRange.addEventListener("input", () => {
  limitValue.textContent = limitRange.value;
});

limitRange.addEventListener("change", async () => {
  const limit = Math.max(5, Math.min(60, Number(limitRange.value) || DEFAULTS.limit));
  limitValue.textContent = String(limit);
  await persistSettings({ limit });
  refreshStats();
});

chrome.storage.sync.get(DEFAULTS, async (result) => {
  applySettingsUI(result);
  await refreshStats();
});

setInterval(refreshStats, 1500);

