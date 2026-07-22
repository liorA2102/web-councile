// Shared by every content script. Injected as a plain (non-module) script
// right after shared/constants.js, before the site-specific file, via
// chrome.scripting.executeScript's `files` array — all three share one
// global scope for the lifetime of the tab's isolated world.
(function () {
  if (self.WC_HELPERS) return; // already loaded in this tab, no-op

  const { MSG_STATUS_UPDATE } = self.WC_CONSTANTS;

  function log(service, ...args) {
    console.log(`[WebCouncile:${service}]`, ...args);
  }

  function sendStatus(service, status, text) {
    log(service, "status ->", status, text ? `(${text.slice(0, 120)})` : "");
    chrome.runtime.sendMessage({
      type: MSG_STATUS_UPDATE,
      service,
      status,
      text,
    });
  }

  // Dispatches keydown/keypress/keyup for Enter so sites that listen on any
  // one of the three (frameworks vary) still see the submit attempt.
  function pressEnter(el) {
    const opts = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // Sets text into a contenteditable div or a textarea/input the way a
  // framework-controlled component expects: dispatching a real `input` event
  // (not just assigning `.value`) so React/Angular's own state picks up the
  // change instead of silently ignoring it.
  function setComposerText(el, text) {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = text;
    } else {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Fallback completion signal: watches `root` for DOM mutations and, once
  // things have been quiet for `quietMs`, re-queries `selector` fresh and
  // calls onSettled with the LAST matching element's text.
  //
  // Deliberately re-queries at finish time rather than watching one node
  // captured earlier: some sites (ChatGPT's reasoning UI, for one) render an
  // interim "Thinking" bubble as its own separate assistant-message element
  // before the real answer bubble exists. If we watch only the first node we
  // found, that interim bubble goes quiet fast (its text is static) and we
  // finalize on "Thinking" before the real answer ever appears — the real
  // content lands in a sibling that our narrow observer never saw mutate.
  // Observing broadly and re-picking the last match at settle time is
  // insensitive to how many interim bubbles a site inserts along the way.
  function watchUntilSettled(root, selector, quietMs, onSettled) {
    let timer = null;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Also arm the timer immediately in case nothing mutates again after we
    // start observing (e.g. the response rendered fully before we attached).
    timer = setTimeout(finish, quietMs);

    function finish() {
      observer.disconnect();
      const nodes = root.querySelectorAll(selector);
      const last = nodes[nodes.length - 1];
      onSettled(last ? last.innerText.trim() : "");
    }
  }

  // Polls (via rAF) for a selector's match count to grow past `countBefore`,
  // resolving with the newest matching node, or null on timeout.
  function waitForNewNode(selector, countBefore, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function check() {
        const nodes = document.querySelectorAll(selector);
        if (nodes.length > countBefore) {
          resolve(nodes[nodes.length - 1]);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve(null);
          return;
        }
        requestAnimationFrame(check);
      })();
    });
  }

  // Best-effort model switching for a brand-new chat. `selectors.modelTrigger`
  // opens the site's own model picker; `selectors.modelOption` matches the
  // resulting list/menu items. With no preferredModel, clicks the FIRST
  // option — an unverified guess that these menus list their most capable
  // tier first. With a preferredModel, clicks the first option whose text
  // contains it (case-insensitive). "default"/"site default" skips entirely.
  //
  // IMPORTANT: modelTrigger/modelOption are unverified placeholders in every
  // site's content script as of this writing — there's been no live look at
  // any of these menus, so this will very likely need the same
  // devtools-inspect-and-fix-the-selector round the composer/send-button
  // selectors needed earlier.
  async function trySetModel(service, selectors, preferredModel) {
    const normalized = (preferredModel || "").trim().toLowerCase();
    if (normalized === "default" || normalized === "site default") {
      log(service, "model: leaving site default (explicitly requested)");
      return;
    }
    if (!selectors.modelTrigger || !selectors.modelOption) {
      log(service, "model: no picker selectors configured, skipping");
      return;
    }
    const trigger = document.querySelector(selectors.modelTrigger);
    if (!trigger) {
      log(service, "model: picker trigger not found (selector may be stale)");
      return;
    }
    trigger.click();
    await new Promise((r) => setTimeout(r, 400));

    const options = Array.from(document.querySelectorAll(selectors.modelOption));
    if (options.length === 0) {
      log(service, "model: picker opened but no options matched (selector may be stale)");
      return;
    }

    const target = normalized
      ? options.find((el) => el.innerText.toLowerCase().includes(normalized))
      : options[0];

    if (!target) {
      log(service, `model: no option matched "${preferredModel}", leaving as-is`);
      trigger.click(); // best-effort: close the menu back up
      return;
    }
    target.click();
    log(service, "model: selected", target.innerText.trim().slice(0, 60));
  }

  self.WC_HELPERS = {
    log,
    sendStatus,
    setComposerText,
    pressEnter,
    watchUntilSettled,
    waitForNewNode,
    trySetModel,
  };
})();
