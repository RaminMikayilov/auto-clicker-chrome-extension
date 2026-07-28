// Generates a unique, reasonably stable CSS selector for an element.
// Exposes globalThis.ACSelector for the content scripts loaded after it.

(function (root) {
  if (root.ACSelector) return;

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

  // Attributes that tend to describe intent rather than presentation, so they
  // survive restyling and class-name churn.
  const STABLE_ATTRS = ['data-testid', 'data-test-id', 'data-qa', 'data-action', 'name', 'aria-label'];

  function isVolatile(token) {
    if (!token) return true;
    if (STATE_WORDS.test(token)) return true;
    return VOLATILE_PATTERNS.some((re) => re.test(token));
  }

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === 'function') return root.CSS.escape(value);
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  // Small wrapper so a bad token can't throw mid-join.
  function escapeSafe(token) {
    try {
      return cssEscape(token);
    } catch {
      return token;
    }
  }

  function isUnique(selector, doc) {
    try {
      return doc.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function stableClasses(el) {
    return Array.from(el.classList).filter((c) => !isVolatile(c));
  }

  // Candidate selectors for a single element, most stable first.
  function candidatesFor(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];

    if (el.id && !isVolatile(el.id)) out.push(`#${escapeSafe(el.id)}`);

    for (const attr of STABLE_ATTRS) {
      const val = el.getAttribute(attr);
      if (val && !isVolatile(val) && val.length < 80) {
        out.push(`${tag}[${attr}="${val.replace(/"/g, '\\"')}"]`);
      }
    }

    const type = el.getAttribute('type');
    if (type) out.push(`${tag}[type="${type}"]`);

    const classes = stableClasses(el);
    if (classes.length) {
      out.push(tag + classes.map((c) => `.${escapeSafe(c)}`).join(''));
      // The most specific class alone is often enough, and survives sibling
      // class churn better than the full set.
      out.push(`${tag}.${escapeSafe(classes[0])}`);
    }

    out.push(tag);
    return out;
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
   * @returns {string} a selector matching exactly `el` within its document.
   */
  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const doc = el.ownerDocument || document;

    // 1. Try to identify the element on its own.
    for (const cand of candidatesFor(el)) {
      if (isUnique(cand, doc)) return cand;
    }

    // 2. Otherwise prepend ancestors until the whole path is unique. Walk all
    //    the way to <body> if needed: a partial path like "div > div > button"
    //    is unanchored and can match an identical branch elsewhere.
    let path = nthOfType(el);
    let node = el.parentElement;

    while (node) {
      // An ancestor with a solid identity lets us stop early and keeps the
      // selector short, which matters for surviving DOM shuffles.
      const anchor = candidatesFor(node).find((c) => isUnique(c, doc));
      if (anchor) {
        const withAnchor = `${anchor} > ${path}`;
        if (isUnique(withAnchor, doc)) return withAnchor;
        const loose = `${anchor} ${path}`;
        if (isUnique(loose, doc)) return loose;
      }

      if (node === doc.body || node === doc.documentElement) {
        // Anchoring at the root makes the path absolute, hence unique.
        return `${node.tagName.toLowerCase()} > ${path}`;
      }

      path = `${nthOfType(node)} > ${path}`;
      if (isUnique(path, doc)) return path;

      node = node.parentElement;
    }

    return path;
  }

  root.ACSelector = { buildSelector };
})(typeof globalThis !== 'undefined' ? globalThis : self);
