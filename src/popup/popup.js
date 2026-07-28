// Toolbar UI. Holds no state of its own -- it renders GET_STATE and sends
// commands to the worker.

(function () {
  const { MSG, REASON, DEFAULT_CONFIG, LIMITS } = AC;

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

  // Keyed by REASON so a rename can't silently orphan a label.
  const STOP_LABELS = {
    [REASON.MANUAL]: 'Stopped.',
    [REASON.MAX_CLICKS]: 'Finished — reached the max click count.',
    [REASON.TAB_CLOSED]: 'Stopped: the target tab was closed.',
    [REASON.NAVIGATED_AWAY]: 'Stopped: the tab navigated to a different site.',
    [REASON.NOT_FOUND]: 'Stopped: the button could not be found.',
  };

  const send = (message) => chrome.runtime.sendMessage(message);

  function showMessage(text, isError = false) {
    els.message.hidden = !text;
    els.message.textContent = text || '';
    els.message.classList.toggle('error', isError);
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function render({ config, run, lastResult, isRunningHere }) {
    // Don't fight the user while they're typing in a field.
    if (document.activeElement !== els.selector) els.selector.value = config.selector;
    if (document.activeElement !== els.interval) els.interval.value = config.intervalSec;
    if (document.activeElement !== els.maxClicks) els.maxClicks.value = config.maxClicks;

    const running = !!run;
    els.status.textContent = running ? 'running' : 'idle';
    els.status.classList.toggle('running', running);

    els.start.disabled = running;
    els.stop.disabled = !running;
    for (const el of [els.pick, els.selector, els.interval, els.maxClicks]) {
      el.disabled = running;
    }

    els.footer.hidden = !running;
    if (running) {
      const n = run.clickCount;
      els.counter.textContent = `${n} click${n === 1 ? '' : 's'}`;
      els.target.textContent = isRunningHere ? 'this tab' : `tab ${run.tabId}`;
      showMessage(isRunningHere ? '' : 'Running in another tab.');
    } else if (lastResult) {
      const label = STOP_LABELS[lastResult.reason] || `Stopped: ${lastResult.reason}`;
      showMessage(`${label} ${lastResult.clickCount} click(s) total.`);
    }
  }

  async function refresh() {
    render(await send({ type: MSG.GET_STATE }));
  }

  function saveConfig() {
    return chrome.storage.local.set({
      selector: els.selector.value.trim(),
      intervalSec: clampInt(
        els.interval.value,
        LIMITS.MIN_INTERVAL_SEC,
        LIMITS.MAX_INTERVAL_SEC,
        DEFAULT_CONFIG.intervalSec
      ),
      maxClicks: clampInt(els.maxClicks.value, 0, LIMITS.MAX_MAX_CLICKS, DEFAULT_CONFIG.maxClicks),
    });
  }

  for (const el of [els.selector, els.interval, els.maxClicks]) {
    el.addEventListener('change', saveConfig);
    el.addEventListener('blur', saveConfig);
  }

  els.pick.addEventListener('click', async () => {
    const res = await send({ type: MSG.START_PICK });
    if (res?.error) return showMessage(res.error, true);
    window.close(); // the picker needs the page, so get out of the way
  });

  els.start.addEventListener('click', async () => {
    await saveConfig();
    showMessage('');
    const res = await send({ type: MSG.START, selector: els.selector.value.trim() });
    if (res?.error) return showMessage(res.error, true);
    await refresh();
  });

  els.stop.addEventListener('click', async () => {
    await send({ type: MSG.STOP, reason: REASON.MANUAL });
    await refresh();
  });

  // Keep the click counter live while the popup is open.
  chrome.storage.session.onChanged?.addListener(refresh);
  const poll = setInterval(refresh, 700);
  addEventListener('unload', () => clearInterval(poll));

  refresh();
})();
