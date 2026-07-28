// Entry point. Disposable by design: re-injected on every page load, runs one
// cycle (wait -> find -> click), then usually dies to the navigation its own
// click caused. The reload IS the loop iteration.
//
// Loaded last, after lib/constants.js, lib/selector.js, content/badge.js and
// content/picker.js.

(function (root) {
  if (root.__acLoaded) return; // the manifest and executeScript can both inject
  root.__acLoaded = true;

  const { MSG, REASON, LIMITS } = root.AC;
  const badge = root.ACBadge;
  const picker = root.ACPicker;

  let cycleToken = 0; // bumping this cancels any in-flight cycle
  let countdownTimer = null;

  const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);

  // --- element readiness ----------------------------------------------------

  function isInteractable(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    // offsetParent is null for display:none -- and also for position:fixed,
    // hence the fallback: a fixed-position button is perfectly clickable.
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /**
   * Resolves with the element once it exists AND is interactable, or null on
   * timeout / invalid selector. A button that exists but is still disabled is
   * the most common silent failure, so both are required.
   */
  function waitForElement(selector, timeout) {
    return new Promise((resolve) => {
      // null = give up now (bad selector), undefined = not ready yet.
      const check = () => {
        let el;
        try {
          el = document.querySelector(selector);
        } catch {
          return null;
        }
        return isInteractable(el) ? el : undefined;
      };

      const immediate = check();
      if (immediate) return resolve(immediate);
      if (immediate === null) return resolve(null);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
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

  // --- clicking -------------------------------------------------------------

  // Frameworks often listen for pointer/mouse events rather than `click`, so
  // fire the whole sequence instead of just el.click().
  function syntheticClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
      buttons: 1,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    };
    const released = { ...base, buttons: 0 };

    el.focus?.({ preventScroll: true });
    for (const type of ['pointerover', 'pointerenter', 'pointermove', 'pointerdown']) {
      el.dispatchEvent(new PointerEvent(type, base));
    }
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup', released));
    el.dispatchEvent(new MouseEvent('mouseup', released));
    el.dispatchEvent(new MouseEvent('click', { ...released, detail: 1 }));
  }

  // --- the cycle ------------------------------------------------------------

  function countdown(ms, token) {
    return new Promise((resolve) => {
      const endAt = Date.now() + ms;
      const tick = () => {
        if (token !== cycleToken) return resolve(false);
        const left = endAt - Date.now();
        if (left <= 0) {
          badge.set('clicking…');
          return resolve(true);
        }
        badge.set(`next click in ${Math.ceil(left / 1000)}s`);
        countdownTimer = setTimeout(tick, Math.min(LIMITS.TICK_MS, left));
      };
      tick();
    });
  }

  function stopCycle() {
    cycleToken += 1;
    clearTimeout(countdownTimer);
    countdownTimer = null;
    badge.remove();
  }

  async function runCycle(state) {
    const token = ++cycleToken;
    badge.show(() => {
      send({ type: MSG.STOP, reason: REASON.MANUAL });
      stopCycle();
    });

    while (token === cycleToken) {
      const ready = await countdown(state.intervalMs, token);
      if (!ready || token !== cycleToken) return;

      const el = await waitForElement(state.selector, LIMITS.FIND_TIMEOUT_MS);
      if (token !== cycleToken) return;

      if (!el) {
        badge.set('button not found');
        const res = await send({ type: MSG.ERROR, reason: REASON.NOT_FOUND });
        if (res?.stopped) return stopCycle();
        continue; // retry on the next interval
      }

      // Report first: the click may navigate and kill this script instantly, so
      // nothing after syntheticClick() is guaranteed to run.
      const res = await send({ type: MSG.WILL_CLICK });
      if (!res?.proceed) return stopCycle();
      if (token !== cycleToken) return;

      badge.set(`clicked ${res.clickCount}×`);
      syntheticClick(el);

      if (res.isLast) return stopCycle();

      // If that click triggered a full reload we're already gone and a fresh
      // instance takes over. If it only re-rendered (SPA), the loop continues.
    }
  }

  // --- wiring ---------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case MSG.START_PICK:
        picker.start((selector) => send({ type: MSG.PICKED, selector }));
        break;
      case MSG.START_CYCLE:
        boot();
        break;
      case MSG.STOP_CYCLE:
        stopCycle();
        break;
    }
  });

  // Cancel in-flight work when our own click navigates away, so a slow
  // navigation can't let the loop fire a second click.
  addEventListener('pagehide', stopCycle);

  async function boot() {
    const state = await send({ type: MSG.HELLO });
    if (!state?.isTarget || !state.selector) return; // dormant in every other tab
    runCycle(state);
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : self);
