const DEFAULTS = {
  enabled: true,
  limit: 15
};

const ICON_PATHS = {
  on: {
    16: "icons/16x16_on.png",
    48: "icons/48x48_on.png",
    128: "icons/128x128_on.png"
  },
  off: {
    16: "icons/16x16_off.png",
    48: "icons/48x48_off.png",
    128: "icons/128x128_off.png"
  }
};

function setTabIcon(tabId, isOn) {
  if (typeof tabId !== "number") return;
  chrome.action.setIcon({
    tabId,
    path: isOn ? ICON_PATHS.on : ICON_PATHS.off
  });
  chrome.action.setBadgeText({ tabId, text: "" });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (result) => {
    chrome.storage.sync.set({
      enabled: typeof result.enabled === "boolean" ? result.enabled : DEFAULTS.enabled,
      limit: Number.isInteger(result.limit) ? result.limit : DEFAULTS.limit
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "setBadge") {
    const tabId = sender?.tab?.id;
    setTabIcon(tabId, Boolean(message.active));
    return;
  }

  if (message.type === "getDefaults") {
    chrome.storage.sync.get(DEFAULTS, (result) => {
      sendResponse({
        enabled: typeof result.enabled === "boolean" ? result.enabled : DEFAULTS.enabled,
        limit: Number.isInteger(result.limit) ? result.limit : DEFAULTS.limit
      });
    });
    return true;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-limiter") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id || !tab.url || !tab.url.startsWith("https://chatgpt.com/")) return;
    chrome.tabs.sendMessage(tab.id, { type: "toggleEnabled" });
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    const isChatGPT = Boolean(tab?.url?.startsWith("https://chatgpt.com/"));
    if (!isChatGPT) {
      setTabIcon(tabId, false);
    }
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    const isChatGPT = Boolean(tab?.url?.startsWith("https://chatgpt.com/"));
    if (!isChatGPT) {
      setTabIcon(tabId, false);
    }
  });
});

