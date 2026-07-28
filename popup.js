const $ = (id) => document.getElementById(id);
const els = {
  selector: $('selector'),
  interval: $('interval'),
  maxClicks: $('maxClicks'),
  pick: $('pick'),
  start: $('start'),
  stop: $('stop'),
  status: $('status'),
  message: $('message'),
  footer: $('footer'),
  counter: $('counter'),
  target: $('target'),
};

const send = (message) => chrome.runtime.sendMessage(message);

function showMessage(text, isError) {
  els.message.hidden = !text;
  els.message.textContent = text || '';
  els.message.classList.toggle('error', !!isError);
}

const STOP_REASONS = {
  manual: 'Stopped.',
  'max-clicks': 'Finished — reached the max click count.',
  'tab-closed': 'Stopped: the target tab was closed.',
  'navigated-away': 'Stopped: the tab navigated to a different site.',
};

function render(state) {
  const { config, run, lastResult, isRunningHere } = state;

  if (document.activeElement !== els.selector) els.selector.value = config.selector;
  if (document.activeElement !== els.interval) els.interval.value = config.intervalSec;
  if (document.activeElement !== els.maxClicks) els.maxClicks.value = config.maxClicks;

  const running = !!run;
  els.status.textContent = running ? 'running' : 'idle';
  els.status.classList.toggle('running', running);

  els.start.disabled = running;
  els.stop.disabled = !running;
  els.pick.disabled = running;
  els.selector.disabled = running;
  els.interval.disabled = running;
  els.maxClicks.disabled = running;

  els.footer.hidden = !running;
  if (running) {
    els.counter.textContent = `${run.clickCount} click${run.clickCount === 1 ? '' : 's'}`;
    els.target.textContent = isRunningHere ? 'this tab' : `tab ${run.tabId}`;
  }

  if (running) {
    showMessage(isRunningHere ? '' : 'Running in another tab.', false);
  } else if (lastResult) {
    const reason = STOP_REASONS[lastResult.reason] || `Stopped: ${lastResult.reason}`;
    showMessage(`${reason} ${lastResult.clickCount} click(s) total.`, false);
  }
}

async function refresh() {
  render(await send({ type: 'GET_STATE' }));
}

function saveConfig() {
  return chrome.storage.local.set({
    selector: els.selector.value.trim(),
    intervalSec: Math.max(1, Number(els.interval.value) || 5),
    maxClicks: Math.max(0, Number(els.maxClicks.value) || 0),
  });
}

for (const el of [els.selector, els.interval, els.maxClicks]) {
  el.addEventListener('change', saveConfig);
  el.addEventListener('blur', saveConfig);
}

els.pick.addEventListener('click', async () => {
  const res = await send({ type: 'START_PICK' });
  if (res?.error) return showMessage(res.error, true);
  // The picker needs the page, so get out of the way.
  window.close();
});

els.start.addEventListener('click', async () => {
  await saveConfig();
  showMessage('', false);
  const res = await send({ type: 'START', selector: els.selector.value.trim() });
  if (res?.error) return showMessage(res.error, true);
  await refresh();
});

els.stop.addEventListener('click', async () => {
  await send({ type: 'STOP', reason: 'manual' });
  await refresh();
});

// Keep the click counter live while the popup is open.
chrome.storage.session.onChanged?.addListener(refresh);
const poll = setInterval(refresh, 700);
window.addEventListener('unload', () => clearInterval(poll));

refresh();
