// Shared by all three contexts, each of which loads classic scripts:
//   service worker  -> importScripts('/lib/constants.js')
//   content scripts -> first entry in the manifest's js array
//   popup           -> <script src="../lib/constants.js">
//
// Wrapped in an IIFE and guarded so a re-injection can't throw on redeclared
// top-level bindings.
(function (root) {
  if (root.AC) return;

  // Message types. Shared so a typo is a reference error instead of a silently
  // ignored message.
  const MSG = Object.freeze({
    // content script -> worker
    HELLO: 'HELLO',
    WILL_CLICK: 'WILL_CLICK',
    ERROR: 'ERROR',
    PICKED: 'PICKED',
    // popup -> worker
    START: 'START',
    STOP: 'STOP',
    GET_STATE: 'GET_STATE',
    START_PICK: 'START_PICK',
    // worker -> content script
    START_CYCLE: 'START_CYCLE',
    STOP_CYCLE: 'STOP_CYCLE',
  });

  // Why a run ended. Produced by the worker, rendered by the popup.
  const REASON = Object.freeze({
    MANUAL: 'manual',
    MAX_CLICKS: 'max-clicks',
    TAB_CLOSED: 'tab-closed',
    NAVIGATED_AWAY: 'navigated-away',
    NOT_FOUND: 'not-found',
  });

  const DEFAULT_CONFIG = Object.freeze({
    selector: '',
    intervalSec: 5,
    maxClicks: 100, // 0 = unlimited
  });

  const LIMITS = Object.freeze({
    // How long to wait for the button to exist and become interactable.
    FIND_TIMEOUT_MS: 15000,
    // Consecutive "button not found" cycles before giving up.
    MAX_CONSECUTIVE_ERRORS: 3,
    MIN_INTERVAL_SEC: 1,
    MAX_INTERVAL_SEC: 3600,
    MAX_MAX_CLICKS: 100000,
    // Countdown repaint cadence.
    TICK_MS: 250,
  });

  root.AC = Object.freeze({ MSG, REASON, DEFAULT_CONFIG, LIMITS });
})(typeof globalThis !== 'undefined' ? globalThis : self);
