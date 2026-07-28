// Disposable content script. Re-injected on every page load; runs one cycle
// (wait -> find -> click) and then usually dies to the navigation its own click
// caused. The reload IS the loop iteration.

(function () {
  if (window.__autoClickerLoaded) return; // manifest + executeScript can both inject
  window.__autoClickerLoaded = true;

  const FIND_TIMEOUT_MS = 15000;
  const buildSelector = window.__autoClickerBuildSelector;

  let cycleToken = 0; // bumping this cancels any in-flight cycle
  let badge = null;
  let badgeText = null;
  let countdownTimer = null;
  let picker = null;

  // --- badge ----------------------------------------------------------------

  // Shadow DOM so the host page's CSS can't restyle or hide our indicator.
  function showBadge() {
    if (badge) return;
    badge = document.createElement('div');
    // `all:initial` must come FIRST -- it is a shorthand for every property, so
    // declaring it after the positioning would reset position/z-index/offsets.
    badge.style.cssText =
      'all:initial;position:fixed;z-index:2147483647;bottom:16px;right:16px;';
    const shadow = badge.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .box {
          font: 500 12px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif;
          background: #14181f; color: #e6edf3; padding: 8px 10px;
          border-radius: 8px; border: 1px solid #2f3742;
          box-shadow: 0 4px 14px rgba(0,0,0,.35);
          display: flex; align-items: center; gap: 10px; white-space: nowrap;
        }
        .dot {
          width: 7px; height: 7px; border-radius: 50%; background: #3fb950;
          animation: p 1.4s ease-in-out infinite;
        }
        @keyframes p { 50% { opacity: .25 } }
        button {
          font: inherit; color: #e6edf3; background: #2f3742; cursor: pointer;
          border: 0; border-radius: 5px; padding: 3px 8px;
        }
        button:hover { background: #3d4754 }
      </style>
      <div class="box"><span class="dot"></span><span id="t">starting…</span>
        <button id="s">Stop</button></div>`;
    badgeText = shadow.getElementById('t');
    shadow.getElementById('s').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP', reason: 'manual' }).catch(() => {});
      stopCycle();
    });
    (document.body || document.documentElement).appendChild(badge);
  }

  function setBadge(text) {
    if (badgeText) badgeText.textContent = text;
  }

  function removeBadge() {
    badge?.remove();
    badge = null;
    badgeText = null;
  }

  // --- helpers --------------------------------------------------------------

  function isInteractable(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    // offsetParent is null for display:none (and position:fixed, hence the rect
    // fallback -- a fixed-position button is perfectly clickable).
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Resolves with the element once it exists AND is interactable. Existing but
  // not-yet-enabled buttons are the most common silent failure.
  function waitForElement(selector, timeout) {
    return new Promise((resolve) => {
      const check = () => {
        let el;
        try {
          el = document.querySelector(selector);
        } catch {
          return null; // invalid selector -- don't spin on it
        }
        return isInteractable(el) ? el : undefined;
      };

      const immediate = check();
      if (immediate) return resolve(immediate);
      if (immediate === null) return resolve(null);

      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(val);
      };

      const observer = new MutationObserver(() => {
        const el = check();
        if (el) finish(el);
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-disabled', 'class', 'style', 'hidden'],
      });

      const timer = setTimeout(() => finish(null), timeout);
    });
  }

  // Frameworks often listen for pointer/mouse events rather than `click`, so
  // fire the whole sequence instead of just el.click().
  function syntheticClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    };

    el.focus?.({ preventScroll: true });
    for (const type of ['pointerover', 'pointerenter', 'pointermove', 'pointerdown']) {
      el.dispatchEvent(new PointerEvent(type, base));
    }
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
  }

  function countdown(ms, token) {
    return new Promise((resolve) => {
      const endAt = Date.now() + ms;
      const tick = () => {
        if (token !== cycleToken) return resolve(false);
        const left = endAt - Date.now();
        if (left <= 0) {
          setBadge('clicking…');
          return resolve(true);
        }
        setBadge(`next click in ${Math.ceil(left / 1000)}s`);
        countdownTimer = setTimeout(tick, Math.min(250, left));
      };
      tick();
    });
  }

  // --- the cycle ------------------------------------------------------------

  function stopCycle() {
    cycleToken += 1;
    clearTimeout(countdownTimer);
    countdownTimer = null;
    removeBadge();
  }

  async function runCycle(state) {
    const token = ++cycleToken;
    showBadge();

    while (token === cycleToken) {
      const proceed = await countdown(state.intervalMs, token);
      if (!proceed || token !== cycleToken) return;

      const el = await waitForElement(state.selector, FIND_TIMEOUT_MS);
      if (token !== cycleToken) return;

      if (!el) {
        setBadge('button not found');
        const res = await send({ type: 'ERROR', reason: 'not-found' });
        if (res?.stopped) return stopCycle();
        continue; // retry on the next interval
      }

      // Tell the worker first: the click may navigate and kill us instantly.
      const res = await send({ type: 'WILL_CLICK' });
      if (!res?.proceed) return stopCycle();
      if (token !== cycleToken) return;

      setBadge(`clicked ${res.clickCount}×`);
      syntheticClick(el);

      if (res.isLast) return stopCycle();

      // If that click triggered a full reload we're already gone and a fresh
      // instance picks up. If it only re-rendered (SPA), the loop continues.
    }
  }

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  // --- element picker -------------------------------------------------------

  function startPick() {
    if (picker) return;

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        #hl { position:fixed; border:2px solid #58a6ff; border-radius:3px;
              background:rgba(88,166,255,.15); transition:all .04s linear; }
        #hint { position:fixed; top:12px; left:50%; transform:translateX(-50%);
                font:500 13px/1 -apple-system,"Segoe UI",system-ui,sans-serif;
                background:#14181f; color:#e6edf3; padding:9px 14px;
                border-radius:8px; border:1px solid #2f3742;
                box-shadow:0 4px 14px rgba(0,0,0,.4); }
      </style>
      <div id="hl" style="display:none"></div>
      <div id="hint">Click the button to automate &nbsp;·&nbsp; Esc to cancel</div>`;
    const hl = shadow.getElementById('hl');
    (document.body || document.documentElement).appendChild(host);

    let target = null;

    const onMove = (e) => {
      target = e.target;
      const r = target.getBoundingClientRect();
      hl.style.display = 'block';
      hl.style.left = `${r.left}px`;
      hl.style.top = `${r.top}px`;
      hl.style.width = `${r.width}px`;
      hl.style.height = `${r.height}px`;
    };

    const kill = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    // Swallow the whole press sequence -- preventDefault on mousedown alone
    // does NOT stop the click event, so the site would still see the click.
    const onPress = (e) => {
      kill(e);
      if (!target) target = e.target;
    };

    // Pick on `click`, i.e. after the full sequence has been swallowed.
    const onClick = (e) => {
      kill(e);
      const el = target || e.target;
      const selector = buildSelector ? buildSelector(el) : '';
      endPick();
      send({ type: 'PICKED', selector });
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        kill(e);
        endPick();
      }
    };

    const opts = { capture: true };
    const PRESS_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick'];
    document.addEventListener('mousemove', onMove, opts);
    document.addEventListener('click', onClick, opts);
    document.addEventListener('keydown', onKey, opts);
    for (const type of PRESS_EVENTS) document.addEventListener(type, onPress, opts);

    picker = () => {
      document.removeEventListener('mousemove', onMove, opts);
      document.removeEventListener('click', onClick, opts);
      document.removeEventListener('keydown', onKey, opts);
      for (const type of PRESS_EVENTS) document.removeEventListener(type, onPress, opts);
      host.remove();
      picker = null;
    };
  }

  function endPick() {
    picker?.();
  }

  // --- wiring ---------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_PICK') startPick();
    else if (msg.type === 'STOP_CYCLE') stopCycle();
    else if (msg.type === 'START_CYCLE') boot();
  });

  // Cancel in-flight work when our own click navigates away, so a slow
  // navigation can't let the loop fire a second click.
  window.addEventListener('pagehide', stopCycle);

  async function boot() {
    const state = await send({ type: 'HELLO' });
    if (!state?.isTarget || !state.selector) return; // dormant in every other tab
    runCycle(state);
  }

  boot();
})();
