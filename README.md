# Auto Clicker (reload-safe)

Clicks one button every N seconds on a site you don't control — and keeps going
even though each click reloads the page.

## Why this isn't just `setInterval`

A `setInterval` in a content script dies the moment the page reloads. Since the
click *causes* a reload, a naive auto-clicker fires exactly once.

This extension inverts the problem: **the reload is the loop iteration.**

```
popup  ──message──▶  service worker  ──message──▶  content scripts
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

## Layout

`src/` is the extension root — that is the folder you load, and the only folder
that ships. Tests and tooling live outside it.

```
auto-clicker/
├── src/                        ← "Load unpacked" selects THIS
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js   owns all state, auto-stop guards
│   ├── content/
│   │   ├── badge.js            on-page status indicator  (ACBadge)
│   │   ├── picker.js           hover-to-pick overlay     (ACPicker)
│   │   └── auto-click.js       the click cycle + wiring   (entry point)
│   ├── lib/
│   │   ├── constants.js        message types, defaults, limits  (AC)
│   │   └── selector.js         selector generation       (ACSelector)
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   └── icons/
├── test/
│   └── fixtures/
│       └── refresh-page.html   a button that really does reload the page
├── tools/
│   └── zip.js                  npm run zip → auto-clicker-<version>.zip
├── package.json
└── README.md
```

### How the three contexts share code

MV3 content scripts can't use ES modules, so everything is a classic script that
attaches one namespace to `globalThis`, wrapped in an idempotent IIFE. The same
`lib/constants.js` file is therefore loaded three different ways:

| Context | Mechanism |
|---|---|
| Service worker | `importScripts('/lib/constants.js')` |
| Content scripts | first entry in the manifest's `js` array |
| Popup | `<script src="../lib/constants.js">` |

That's what lets message types live in exactly one place (`AC.MSG`) instead of
being repeated as string literals in four files, where a typo is a silently
ignored message rather than an error.

Load order matters: `constants → selector → badge → picker → auto-click`. If you
add or rename a content-script file, update it in **two** places — the manifest's
`js` array and `CONTENT_SCRIPTS` in `service-worker.js`, which is the list used
for on-demand injection into pages that predate the extension install.

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select the **`src`** folder.

To test against `test/fixtures/refresh-page.html` over `file://`, also open the
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

## Gotchas

Four traps found the hard way. Each is load-bearing — the code looks fine without
the fix, and fails subtly with it removed.

- **Selector paths must be anchored.** A path like `div > div > button` can match
  an identical branch elsewhere in the page, so the ancestor walk in
  `buildSelector()` continues until it reaches `<body>`.
- **A race that silently drops the final click.** `clearRun()` must not send
  `STOP_CYCLE` when it fires from `WILL_CLICK` at the max-clicks boundary: the
  message races the pending response and cancels the very click it just
  authorised. That's what the `notify: false` argument is for.
- **`all:initial` must come first.** On the badge and picker overlay it's a
  shorthand for *every* property, so declaring it after `position:fixed` silently
  resets the positioning.
- **`preventDefault()` on `mousedown` does not stop the `click`.** The picker has
  to swallow the whole press sequence (`pointerdown`, `mousedown`, `pointerup`,
  `mouseup`, `auxclick`, then `click`), or the site receives your pick as a real
  click.

## Packaging

```
npm run zip     # -> auto-clicker-<version>.zip, containing src/ at the root
```

`tools/zip.js` writes the archive itself rather than shelling out, because
`Compress-Archive` and .NET Framework's `ZipFile` both emit Windows backslashes
as entry names — out of spec, and rejected by some tooling. Output is
byte-reproducible for identical input.

## Known limitation: `isTrusted`

Synthetic events carry `isTrusted: false`, and no content script can forge a
trusted event. A site that checks `event.isTrusted` will ignore these clicks.

`auto-click.js` dispatches the full `pointerover → pointerdown → mousedown →
pointerup → mouseup → click` sequence rather than bare `el.click()`, which
satisfies almost every framework — but not an explicit `isTrusted` check. If you
hit that wall, the only real escape hatch is the `chrome.debugger` API
(`Input.dispatchMouseEvent`), which produces genuinely trusted input at the cost
of a persistent "debugging this browser" banner. Not implemented here.

## Notes

- Background tabs throttle timers to ~1s minimum. Fine for second-scale
  intervals; sub-second intervals need the tab visible.
- If the click only re-renders the page (SPA) instead of reloading it, the
  content script survives and keeps looping in place. Both cases work.
- Clicks are reported to the worker *before* dispatching, because navigation can
  kill the script before any post-click code runs. The count stays accurate.
- `host_permissions` is `<all_urls>` so the picker works anywhere. To narrow it,
  replace that with the specific origin in `src/manifest.json` — the content
  scripts stay dormant everywhere except the target tab regardless.
