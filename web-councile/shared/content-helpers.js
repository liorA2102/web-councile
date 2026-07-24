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

  function composerIsEmpty(composer) {
    const text = composer.isContentEditable ? composer.textContent : composer.value;
    return !text || !text.trim();
  }

  // Clicks the send button (or falls back to Enter) and CONFIRMS it actually
  // took effect — a sent message clears the composer, so if it's still
  // sitting there after a short wait, the click/Enter never really landed
  // and we retry instead of silently moving on to wait for a reply that will
  // never come.
  //
  // This matters most for a brand-new chat: our waitForElement only confirms
  // the composer DOM node exists, not that the site's own framework has
  // finished wiring real input handling to it yet (React/ProseMirror etc.
  // can still be attaching listeners to a just-mounted node for a beat after
  // it's queryable). A synthetic click/Enter sent into that gap can be a
  // silent no-op: the framework never registers it as a real submit, so the
  // typed prompt is left sitting in the composer, unsent, while we'd
  // otherwise go on to wait 45s for a response that was never actually
  // requested. An already-open, already-interacted-with conversation's
  // composer doesn't have this gap, which is why this mainly shows up for
  // fresh sessions (a brand-new chat, or the consolidation judge's first
  // use) rather than a reused one.
  async function submitComposer(composer, sendButtonSelector) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (composerIsEmpty(composer)) return true;
      const sendBtn = document.querySelector(sendButtonSelector);
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        pressEnter(composer);
      }
      await new Promise((r) => setTimeout(r, 500 + attempt * 400));
    }
    return composerIsEmpty(composer);
  }

  // Strips UI chrome that leaks into innerText-based extraction on modern
  // reasoning-model interfaces:
  //  - screen-reader-only "<Model> responded:" labels — a11y text nodes that
  //    use a visually-hidden CSS technique (clipped, not display:none) which
  //    innerText doesn't always exclude the way it does true display:none
  //  - "Thought for Xs" reasoning-disclosure headers, which some sites leave
  //    visible above the final answer even after it's done, sometimes with a
  //    duplicate (once for the live label, once for an a11y-only echo)
  //  - stray private-use-area glyphs from icon fonts (the collapse/expand
  //    toggle icon) that render as a tofu box with no real text meaning
  //  - a line that exactly repeats the last non-blank line before it — the
  //    same a11y-echo mechanism that duplicates the "<Model> responded:"
  //    label above sometimes duplicates a short summary/title line too
  // General cleanup applied to every extraction, not site-specific.
  function cleanExtractedText(text) {
    const lines = text
      .replace(/^\s*(ChatGPT|Claude|Gemini)\s+responded:\s*/i, "")
      .split("\n")
      .map((line) => line.replace(/[\uE000-\uF8FF]/g, "").trim())
      .filter((line) => !/^Thought for\s+[\w\s]+$/i.test(line));

    let lastNonBlank = null;
    const deduped = lines.filter((line) => {
      if (line === "") return true;
      if (line === lastNonBlank) return false;
      lastNonBlank = line;
      return true;
    });

    return deduped
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Queries a selector that may be a single string or an ordered list of
  // candidate strings. A candidate list is deliberately NOT combined into one
  // comma-separated selector: querySelectorAll on a comma list returns
  // matches in DOM order across every alternative, not "prefer the first
  // listed" — when two candidates target structurally different things (a
  // full message container vs. an inner streaming-status fragment), that can
  // hand back the wrong one depending on where it happens to sit in the DOM.
  // Same reasoning as findComposer's composerCandidates in chatgpt.js, just
  // generalized so every candidate-selector site (assistantMessage included)
  // gets the same "try the first candidate that actually matches, in order"
  // behavior instead of each content script reimplementing it.
  function queryAllCandidates(root, selector) {
    const candidates = Array.isArray(selector) ? selector : [selector];
    for (const candidate of candidates) {
      const nodes = root.querySelectorAll(candidate);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  // Fallback completion signal: watches `root` for DOM mutations and, once
  // things have been quiet for `quietMs`, re-queries `selector` fresh and
  // calls onSettled with the LAST matching element's (cleaned) text.
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
    // A short, generic-looking snippet ("Thinking", "Cogitating",
    // "Sleuthing"...) at quiet-time is often a reasoning-in-progress
    // placeholder bubble that just hasn't been replaced by the real answer
    // yet, rather than a genuinely settled (if unusually short) reply — if
    // the model pauses during that reasoning phase for longer than quietMs
    // with no DOM mutations, we'd otherwise lock in the placeholder as
    // "done". Give it a few longer quiet windows to prove itself before
    // trusting it, instead of finalizing on the first quiet tick; give up
    // and accept it after a bounded number of retries so this can't hang
    // forever on a genuinely short real answer.
    //
    // A tool-call/reasoning status line ("Searching the web", "Thinking
    // about…") is the same problem in a different shape: the model can go
    // quiet for longer than quietMs between starting a tool call or an
    // extended-thinking pass and the real answer actually landing, which
    // locks in that status line as the final answer instead of waiting —
    // this is especially likely for consolidation, whose prompt bundles all
    // 3 members' full answers and so gives a reasoning model much more to
    // visibly "think" through before the real synthesized reply exists.
    // Checked against the FIRST line too (not just the last): a live
    // "Thinking about X…" opener with no final answer rendered yet is still
    // the entire captured text at settle time, not just a trailing status
    // fragment after other content.
    let placeholderRetriesLeft = 3;
    const TOOL_STATUS_LINE =
      /^(thinking|searching|browsing|reading|looking (up|for|into)|fetching|analyzing|running)\b/i;

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

    function looksUnsettled(text) {
      const trimmed = text.trim();
      if (!trimmed) return false;
      const nonBlankLines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
      const firstLine = nonBlankLines[0] || trimmed;
      const lastLine = nonBlankLines[nonBlankLines.length - 1] || trimmed;
      if (TOOL_STATUS_LINE.test(firstLine) || TOOL_STATUS_LINE.test(lastLine)) return true;
      const words = trimmed.split(/\s+/);
      return trimmed.length < 24 && words.length <= 3;
    }

    function finish() {
      const nodes = queryAllCandidates(root, selector);
      const last = nodes[nodes.length - 1];
      const text = last ? cleanExtractedText(last.innerText) : "";
      if (looksUnsettled(text) && placeholderRetriesLeft > 0) {
        placeholderRetriesLeft -= 1;
        timer = setTimeout(finish, quietMs * 4);
        return;
      }
      observer.disconnect();
      onSettled(text);
    }
  }

  // Waits for `find()` (a zero-arg function returning an element or null) to
  // start returning a truthy element. Covers the gap between chrome.tabs
  // reaching "complete" (background.js's waitForTabComplete, which fires on
  // plain page load) and a heavy client-rendered SPA actually mounting its
  // composer — chatgpt.com/gemini.google.com in particular can still be
  // hydrating well after "complete", so a single immediate querySelector
  // right after injection can race a real, not-actually-stale selector and
  // misreport it as one. Combines a MutationObserver (fast path) with a
  // polling fallback (covers mounts a subtree observer on document.body
  // might miss, e.g. inside a shadow root) rather than either alone.
  function waitForElement(find, timeoutMs) {
    return new Promise((resolve) => {
      const existing = find();
      if (existing) {
        resolve(existing);
        return;
      }

      let settled = false;
      const observer = new MutationObserver(() => {
        const el = find();
        if (el) finish(el);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const poll = setInterval(() => {
        const el = find();
        if (el) finish(el);
      }, 300);
      const timer = setTimeout(() => finish(null), timeoutMs);

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        observer.disconnect();
        resolve(result);
      }
    });
  }

  // How long to allow before giving up waiting for the model's first reply
  // chunk to appear at all. A fixed value works for a normal short question,
  // but the consolidation step sends a much longer prompt (it bundles all 3
  // members' full answers) — a model can reasonably take longer to even
  // start replying to that than to a one-line question. Scale the allowance
  // with prompt length instead of assuming every prompt is equally quick to
  // start.
  const BASE_START_TIMEOUT_MS = 15000;
  const EXTRA_START_MS_PER_CHAR = 2;
  const MAX_EXTRA_START_MS = 30000;
  function startTimeoutFor(prompt) {
    return BASE_START_TIMEOUT_MS + Math.min(MAX_EXTRA_START_MS, (prompt?.length || 0) * EXTRA_START_MS_PER_CHAR);
  }

  // Watches for a selector's match count to grow past `countBefore`,
  // resolving with the newest matching node, or null on timeout. Uses a
  // MutationObserver rather than polling via rAF/setTimeout — rAF in
  // particular is paused by the browser for any tab that isn't the frontmost
  // visible one, which meant this would silently hang forever for whichever
  // of the 3 LLM tabs wasn't in focus at send time (i.e. 2 out of 3, always).
  // MutationObserver callbacks fire off real DOM mutations regardless of tab
  // visibility, so this now works the same whether the tab is on screen or
  // sitting in the background.
  function waitForNewNode(selector, countBefore, timeoutMs) {
    return new Promise((resolve) => {
      const already = queryAllCandidates(document, selector);
      if (already.length > countBefore) {
        resolve(already[already.length - 1]);
        return;
      }

      let settled = false;
      const observer = new MutationObserver(() => {
        const nodes = queryAllCandidates(document, selector);
        if (nodes.length > countBefore) finish(nodes[nodes.length - 1]);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(null), timeoutMs);

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(result);
      }
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

  // Best-effort file attachment for a prompt with media. `media` is
  // [{ name, type, dataUrl }]. Converts each data URL back to a real File and
  // assigns them to the site's own hidden file input via a DataTransfer, then
  // fires a change event — the same trick a real drag-and-drop or file
  // picker interaction ends with.
  //
  // IMPORTANT: selectors.fileInput is an unverified placeholder in every
  // site's content script as of this writing, same caveat as
  // modelTrigger/modelOption above — no live look at any of these upload
  // mechanisms yet. Some sites may require a drop event on the composer
  // instead of a file input; that would need its own follow-up if this
  // simpler approach doesn't pan out.
  async function tryAttachMedia(service, selectors, media) {
    if (!media || media.length === 0) return;
    if (!selectors.fileInput) {
      log(service, "media: no file input selector configured, skipping attachment");
      return;
    }
    const input = document.querySelector(selectors.fileInput);
    if (!input) {
      log(service, "media: file input not found (selector may be stale)");
      return;
    }
    try {
      const files = await Promise.all(media.map(dataUrlToFile));
      const dataTransfer = new DataTransfer();
      files.forEach((file) => dataTransfer.items.add(file));
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      log(service, `media: attached ${files.length} file(s) via file input`);
    } catch (err) {
      log(service, "media: attachment failed:", err);
    }
  }

  async function dataUrlToFile({ name, type, dataUrl }) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], name, { type });
  }

  self.WC_HELPERS = {
    log,
    sendStatus,
    setComposerText,
    pressEnter,
    submitComposer,
    watchUntilSettled,
    waitForNewNode,
    waitForElement,
    queryAllCandidates,
    startTimeoutFor,
    trySetModel,
    tryAttachMedia,
  };
})();
