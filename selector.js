// Generates a unique, reasonably stable CSS selector for an element.
// Loaded before content.js, so it just defines a global on window.

(function () {
  // Class names / ids that look machine-generated or state-dependent are
  // useless across reloads, so they get filtered out.
  const VOLATILE_PATTERNS = [
    /^[a-f0-9]{6,}$/i, // pure hash
    /[a-f0-9]{8,}/i, // embedded hash
    /^:r[0-9a-z]+:?$/i, // React useId
    /^(css|sc|jsx|emotion|styled)-/i, // CSS-in-JS
    /\d{4,}/, // long digit runs
  ];

  const STATE_WORDS =
    /(^|[-_])(active|hover|focus|selected|open|closed|current|disabled|loading|hidden|visible|expanded)([-_]|$)/i;

  function isVolatile(token) {
    if (!token) return true;
    if (STATE_WORDS.test(token)) return true;
    return VOLATILE_PATTERNS.some((re) => re.test(token));
  }

  function cssEscape(value) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  function isUnique(selector, root) {
    try {
      return root.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function stableClasses(el) {
    return Array.from(el.classList).filter((c) => !isVolatile(c));
  }

  // Candidate selectors for a single element, cheapest/most stable first.
  function candidatesFor(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];

    if (el.id && !isVolatile(el.id)) out.push(`#${cssEscape(el.id)}`);

    for (const attr of ['data-testid', 'data-test-id', 'data-qa', 'data-action', 'name', 'aria-label']) {
      const val = el.getAttribute(attr);
      if (val && !isVolatile(val) && val.length < 80) {
        out.push(`${tag}[${attr}="${val.replace(/"/g, '\\"')}"]`);
      }
    }

    const type = el.getAttribute('type');
    if (type) out.push(`${tag}[type="${type}"]`);

    const classes = stableClasses(el);
    if (classes.length) {
      out.push(tag + classes.map((c) => `.${escapeClass(c)}`).join(''));
      // Single most specific class alone is often enough and survives
      // sibling class churn better than the full set.
      out.push(`${tag}.${escapeClass(classes[0])}`);
    }

    out.push(tag);
    return out;
  }

  // Small wrapper so a bad class token can't throw mid-join.
  function escapeClass(c) {
    try {
      return cssEscape(c);
    } catch {
      return c;
    }
  }

  function nthOfType(el) {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (sameTag.length === 1) return tag;
    return `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
  }

  /**
   * @param {Element} el
   * @returns {string} a selector matching exactly `el` within its document,
   *   or a best-effort path selector if uniqueness can't be reached.
   */
  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const root = el.ownerDocument || document;

    // 1. Try to identify the element on its own.
    for (const cand of candidatesFor(el)) {
      if (isUnique(cand, root)) return cand;
    }

    // 2. Otherwise prepend ancestors until the whole path is unique. Walk all
    //    the way to <body> if needed: a partial path like "div > div > button"
    //    is unanchored and can match an identical branch elsewhere.
    let path = nthOfType(el);
    let node = el.parentElement;

    while (node) {
      // An ancestor with a solid identity lets us stop early and keeps the
      // selector short, which matters for surviving DOM shuffles.
      const anchor = candidatesFor(node).find((c) => isUnique(c, root));
      if (anchor) {
        const withAnchor = `${anchor} > ${path}`;
        if (isUnique(withAnchor, root)) return withAnchor;
        const loose = `${anchor} ${path}`;
        if (isUnique(loose, root)) return loose;
      }

      if (node === root.body || node === root.documentElement) {
        // Anchoring at the root makes the path absolute, hence unique.
        return `${node.tagName.toLowerCase()} > ${path}`;
      }

      path = `${nthOfType(node)} > ${path}`;
      if (isUnique(path, root)) return path;

      node = node.parentElement;
    }

    return path;
  }

  window.__autoClickerBuildSelector = buildSelector;
})();
