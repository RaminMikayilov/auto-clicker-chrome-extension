// Service worker: owns all state. MV3 kills this after ~30s idle, so nothing
// lives in globals -- every handler reads and writes chrome.storage.
//
// storage.local   -> config that should survive a browser restart
// storage.session -> run state, which must NOT survive (a stale tabId from a
//                    previous session would point at an unrelated tab)

const DEFAULT_CONFIG = {
  selector: '',
  intervalSec: 5,
  maxClicks: 100, // 0 = unlimited
};

const MAX_CONSECUTIVE_ERRORS = 3;

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
}

async function getRun() {
  const { run } = await chrome.storage.session.get({ run: null });
  return run;
}

async function setRun(run) {
  await chrome.storage.session.set({ run });
}

// `notify: false` is for stops the content script already knows about. Sending
// STOP_CYCLE there would race the pending WILL_CLICK response and cancel the
// very click we just authorised.
async function clearRun(reason, { notify = true } = {}) {
  const run = await getRun();
  await chrome.storage.session.set({
    run: null,
    lastResult: run
      ? { reason, clickCount: run.clickCount, stoppedAt: Date.now() }
      : { reason, clickCount: 0, stoppedAt: Date.now() },
  });
  await updateBadge();
  if (run && notify) notifyTab(run.tabId, { type: 'STOP_CYCLE', reason });
}

function notifyTab(tabId, message) {
  // The tab may be gone or have no content script (chrome:// pages); ignore.
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function updateBadge() {
  const run = await getRun();
  if (run) {
    await chrome.action.setBadgeText({ text: String(run.clickCount) });
    await chrome.action.setBadgeBackgroundColor({ color: '#2f855a' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// --- messages ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err) }));
  return true; // keep the channel open for the async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'HELLO':
      return handleHello(sender);
    case 'WILL_CLICK':
      return handleWillClick(sender);
    case 'ERROR':
      return handleError(sender, msg.reason);
    case 'START':
      return handleStart(msg);
    case 'STOP':
      await clearRun(msg.reason || 'manual');
      return { ok: true };
    case 'GET_STATE':
      return handleGetState();
    case 'START_PICK':
      return handleStartPick();
    case 'PICKED':
      await chrome.storage.local.set({ selector: msg.selector });
      return { ok: true };
    default:
      return { error: `unknown message: ${msg.type}` };
  }
}

// A content script can't read its own tab id, so it asks us and we read it off
// the sender. This is what makes tab-scoping work across reloads: the tab id is
// stable when a page reloads itself.
async function handleHello(sender) {
  const tabId = sender.tab?.id;
  const run = await getRun();
  if (!run || tabId !== run.tabId) return { isTarget: false };

  // A cross-origin navigation means we're no longer on the page the user
  // pointed at -- refuse to keep clicking there.
  const origin = originOf(sender.tab.url);
  if (origin && run.origin && origin !== run.origin) {
    await clearRun('navigated-away');
    return { isTarget: false };
  }

  const config = await getConfig();
  return {
    isTarget: true,
    selector: config.selector,
    intervalMs: Math.max(1, config.intervalSec) * 1000,
    clickCount: run.clickCount,
    maxClicks: config.maxClicks,
  };
}

// Called *before* the click lands, because the resulting navigation can kill
// the content script before any post-click code runs.
async function handleWillClick(sender) {
  const run = await getRun();
  if (!run || sender.tab?.id !== run.tabId) return { proceed: false };

  const config = await getConfig();
  const nextCount = run.clickCount + 1;

  if (config.maxClicks > 0 && nextCount > config.maxClicks) {
    await clearRun('max-clicks');
    return { proceed: false };
  }

  await setRun({ ...run, clickCount: nextCount, errorStreak: 0, lastClickAt: Date.now() });
  await updateBadge();

  // The response's isLast tells the content script to stop itself after the
  // click, so don't also push it a STOP_CYCLE.
  const done = config.maxClicks > 0 && nextCount >= config.maxClicks;
  if (done) await clearRun('max-clicks', { notify: false });

  return { proceed: true, clickCount: nextCount, isLast: done };
}

async function handleError(sender, reason) {
  const run = await getRun();
  if (!run || sender.tab?.id !== run.tabId) return { ok: true };

  const errorStreak = (run.errorStreak || 0) + 1;
  if (errorStreak >= MAX_CONSECUTIVE_ERRORS) {
    await clearRun(`error: ${reason}`);
    return { ok: true, stopped: true };
  }

  await setRun({ ...run, errorStreak, lastError: reason });
  return { ok: true, stopped: false, errorStreak };
}

async function handleStart(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { error: 'No active tab.' };

  const config = await getConfig();
  const selector = msg.selector || config.selector;
  if (!selector) return { error: 'Pick a button first.' };

  // Verify the selector actually resolves before we commit to a run.
  const found = await selectorExists(tab.id, selector);
  if (found === null) {
    return { error: "Can't run on this page (restricted URL)." };
  }
  if (!found) {
    return { error: 'That selector matches nothing on this page.' };
  }

  await chrome.storage.session.set({ lastResult: null });
  await setRun({
    tabId: tab.id,
    origin: originOf(tab.url),
    clickCount: 0,
    errorStreak: 0,
    startedAt: Date.now(),
  });
  await updateBadge();

  // Kick the content script directly; it won't get a fresh HELLO until the next
  // page load. Inject first, in case this page predates the extension install.
  await ensureInjected(tab.id);
  notifyTab(tab.id, { type: 'START_CYCLE' });
  return { ok: true, tabId: tab.id };
}

async function selectorExists(tabId, selector) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        try {
          return !!document.querySelector(sel);
        } catch {
          return false;
        }
      },
      args: [selector],
    });
    return !!result?.result;
  } catch {
    return null; // chrome://, the web store, or a missing host permission
  }
}

async function handleGetState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const config = await getConfig();
  const run = await getRun();
  const { lastResult } = await chrome.storage.session.get({ lastResult: null });

  return {
    config,
    run,
    lastResult,
    activeTabId: tab?.id ?? null,
    activeTabUrl: tab?.url ?? '',
    isRunningHere: !!run && run.tabId === tab?.id,
  };
}

// The content script is declared in the manifest, but a page that was already
// open before install won't have it. Injecting again is harmless -- content.js
// guards against double injection.
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['selector.js', 'content.js'],
    });
    return true;
  } catch {
    return false;
  }
}

async function handleStartPick() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { error: 'No active tab.' };

  if (!(await ensureInjected(tab.id))) {
    return { error: "Can't run on this page (restricted URL)." };
  }

  notifyTab(tab.id, { type: 'START_PICK' });
  return { ok: true };
}

// --- auto-stop guards ------------------------------------------------------

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const run = await getRun();
  if (run && run.tabId === tabId) await clearRun('tab-closed');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const run = await getRun();
  if (!run || run.tabId !== tabId) return;

  const origin = originOf(changeInfo.url);
  if (origin && run.origin && origin !== run.origin) {
    await clearRun('navigated-away');
  }
});

// A browser restart wipes session storage automatically; this just keeps the
// badge from lingering.
chrome.runtime.onStartup.addListener(() => updateBadge());
chrome.runtime.onInstalled.addListener(() => updateBadge());
