// On-page status indicator: live countdown plus a Stop button. Deliberately
// always visible -- an auto-clicker should never run invisibly.
// Exposes globalThis.ACBadge.

(function (root) {
  if (root.ACBadge) return;

  let host = null;
  let label = null;

  /**
   * @param {() => void} onStop invoked when the user clicks Stop.
   */
  function show(onStop) {
    if (host) return;

    host = document.createElement('div');
    // `all:initial` must come FIRST -- it is a shorthand for every property, so
    // declaring it after the positioning would reset position/z-index/offsets.
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;bottom:16px;right:16px;';

    // A closed shadow root keeps the host page's CSS from restyling or hiding us.
    const shadow = host.attachShadow({ mode: 'closed' });
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
          animation: pulse 1.4s ease-in-out infinite;
        }
        @keyframes pulse { 50% { opacity: .25 } }
        button {
          font: inherit; color: #e6edf3; background: #2f3742; cursor: pointer;
          border: 0; border-radius: 5px; padding: 3px 8px;
        }
        button:hover { background: #3d4754 }
      </style>
      <div class="box">
        <span class="dot"></span><span id="label">starting…</span>
        <button id="stop" type="button">Stop</button>
      </div>`;

    label = shadow.getElementById('label');
    shadow.getElementById('stop').addEventListener('click', onStop);
    (document.body || document.documentElement).appendChild(host);
  }

  function set(text) {
    if (label) label.textContent = text;
  }

  function remove() {
    host?.remove();
    host = null;
    label = null;
  }

  root.ACBadge = { show, set, remove };
})(typeof globalThis !== 'undefined' ? globalThis : self);
