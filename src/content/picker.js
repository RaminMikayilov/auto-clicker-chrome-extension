// Hover-to-highlight element picker. Reports the chosen selector through a
// callback; all messaging stays in auto-click.js.
// Exposes globalThis.ACPicker.

(function (root) {
  if (root.ACPicker) return;

  // Every event in a press sequence has to be swallowed: preventDefault() on
  // mousedown alone does NOT stop the subsequent click, so the site would still
  // see the user's pick as a real click.
  const PRESS_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick'];
  const OPTS = { capture: true };

  let teardown = null;

  /**
   * @param {(selector: string) => void} onPick called once with the selector.
   */
  function start(onPick) {
    if (teardown) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow = overlay.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        #highlight {
          position: fixed; border: 2px solid #58a6ff; border-radius: 3px;
          background: rgba(88,166,255,.15); transition: all .04s linear;
        }
        #hint {
          position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
          font: 500 13px/1 -apple-system, "Segoe UI", system-ui, sans-serif;
          background: #14181f; color: #e6edf3; padding: 9px 14px;
          border-radius: 8px; border: 1px solid #2f3742;
          box-shadow: 0 4px 14px rgba(0,0,0,.4);
        }
      </style>
      <div id="highlight" style="display:none"></div>
      <div id="hint">Click the button to automate &nbsp;·&nbsp; Esc to cancel</div>`;

    const highlight = shadow.getElementById('highlight');
    (document.body || document.documentElement).appendChild(overlay);

    let target = null;

    const kill = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    const onMove = (e) => {
      target = e.target;
      const r = target.getBoundingClientRect();
      highlight.style.display = 'block';
      highlight.style.left = `${r.left}px`;
      highlight.style.top = `${r.top}px`;
      highlight.style.width = `${r.width}px`;
      highlight.style.height = `${r.height}px`;
    };

    const onPress = (e) => {
      kill(e);
      if (!target) target = e.target;
    };

    // Pick on `click`, i.e. after the whole sequence has been swallowed.
    const onClick = (e) => {
      kill(e);
      const el = target || e.target;
      const selector = root.ACSelector ? root.ACSelector.buildSelector(el) : '';
      stop();
      onPick(selector);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        kill(e);
        stop();
      }
    };

    document.addEventListener('mousemove', onMove, OPTS);
    document.addEventListener('click', onClick, OPTS);
    document.addEventListener('keydown', onKey, OPTS);
    for (const type of PRESS_EVENTS) document.addEventListener(type, onPress, OPTS);

    teardown = () => {
      document.removeEventListener('mousemove', onMove, OPTS);
      document.removeEventListener('click', onClick, OPTS);
      document.removeEventListener('keydown', onKey, OPTS);
      for (const type of PRESS_EVENTS) document.removeEventListener(type, onPress, OPTS);
      overlay.remove();
      teardown = null;
    };
  }

  function stop() {
    teardown?.();
  }

  root.ACPicker = {
    start,
    stop,
    get active() {
      return !!teardown;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
