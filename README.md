# Auto Clicker (reload-safe)

Clicks one button every N seconds on a site you don't control — and keeps going
even though each click reloads the page.

## Why this isn't just `setInterval`

A `setInterval` in a content script dies the moment the page reloads. Since the
click *causes* a reload, a naive auto-clicker fires exactly once.

This extension inverts the problem: **the reload is the loop iteration.**

```
popup  ──message──▶  service worker  ──message──▶  content script
(UI)                 (state owner)                 (disposable, 1 cycle/load)
                          │
                          ▼
                   chrome.storage
              local:   selector, intervalSec, maxClicks
              session: active tabId, clickCount, errorStreak
```

The content script is disposable. On every page load it re-injects, sends a
`HELLO`, and asks the worker "am I the target tab, and is a job running?" If yes
it runs one cycle — wait N seconds → wait for the button to be clickable → click.
That click reloads the page, a fresh content script starts, and the cycle repeats.

Two details that make it hold together:

- **The worker keeps no state in globals.** MV3 terminates it after ~30s idle,
  so every handler reads/writes `chrome.storage`. Incoming messages wake it.
- **A content script can't read its own tab ID.** It asks, and the worker reads
  `sender.tab.id` off the message. A tab ID is stable across a self-reload,
  which is what makes "only the tab I started it in" work.

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select this folder.

To test against `test/refresh-page.html` over `file://`, also open the
extension's **Details** and enable **Allow access to file URLs**.

## Use

1. Open the target page and click the extension icon.
2. **Pick** → the popup closes and the page enters picker mode. Hover the button
   (blue highlight), click it once. The click is swallowed, so the site never
   sees it. `Esc` cancels.
3. Set the interval and a **max clicks** value, then **Start**.
4. A badge appears bottom-right on the page with a live countdown and a Stop
   button. The toolbar icon shows the click count.

Interval is measured from each page load, so the real gap between clicks is
`N + page load time`.

## Auto-stop guards

It stops on its own when:

- max clicks is reached (`0` = unlimited),
- the target tab is closed,
- that tab navigates to a different origin,
- the button can't be found 3 cycles in a row,
- you press Stop (in the popup or on the page badge).

Run state lives in `chrome.storage.session`, so a browser restart always clears
it — a stale tab ID would otherwise point at an unrelated tab.

## Known limitation: `isTrusted`

Synthetic events carry `isTrusted: false`, and no content script can forge a
trusted event. A site that checks `event.isTrusted` will ignore these clicks.

`content.js` dispatches the full `pointerover → pointerdown → mousedown →
pointerup → mouseup → click` sequence rather than bare `el.click()`, which
satisfies almost every framework — but not an explicit `isTrusted` check. If you
hit that wall, the only real escape hatch is the `chrome.debugger` API
(`Input.dispatchMouseEvent`), which produces genuinely trusted input at the cost
of a persistent "debugging this browser" banner. Not implemented here.

## Tests

79 tests over the three pieces of real logic, run under jsdom with a stubbed
`chrome` API:

```
npm install
npm test
```

- `test/selector.test.js` (15) — selector generation: hashed/`useId` ids rejected,
  CSS-in-JS and state classes dropped, escaping, identical siblings, deep
  anonymous nesting.
- `test/cycle.test.js` (20) — the click cycle: stays dormant in non-target tabs,
  waits out the interval, waits for a `disabled` button to enable, waits for an
  element injected after load, full event sequence reaches a real listener,
  `WILL_CLICK` precedes the click, stop/pagehide cancellation, double-injection
  safety.
- `test/background.test.js` (44) — the state machine: click counting, every
  auto-stop guard, cross-origin refusal, foreign-tab rejection.

Two bugs these caught during development, both worth knowing about if you edit
the code:

- An unanchored selector path (`div > div > button`) can match an identical
  branch elsewhere in the page — the ancestor walk must reach `<body>`.
- `clearRun()` must **not** send `STOP_CYCLE` when it fires from `WILL_CLICK` at
  the max-clicks boundary: the message races the pending response and cancels
  the very click it just authorised.

## Notes

- Background tabs throttle timers to ~1s minimum. Fine for second-scale
  intervals; sub-second intervals need the tab visible.
- If the click only re-renders the page (SPA) instead of reloading it, the
  content script survives and keeps looping in place. Both cases work.
- Clicks are reported to the worker *before* dispatching, because navigation can
  kill the script before any post-click code runs. The count stays accurate.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker — owns all state, auto-stop guards |
| `content.js` | One click cycle per page load, on-page badge, element picker |
| `selector.js` | `buildSelector(el)` — unique, churn-resistant CSS selectors |
| `popup.*` | Toolbar UI |
| `test/refresh-page.html` | Local page whose button really does reload it |
