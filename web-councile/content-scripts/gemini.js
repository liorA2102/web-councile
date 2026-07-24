// Content script for gemini.google.com.
//
// IMPORTANT: these selectors are best-effort guesses based on durable-ish
// attributes (aria-label, contenteditable, role). Gemini's markup changes
// over time — if status never leaves "Waiting…"/"Sending…" or the response
// comes back empty, open devtools on gemini.google.com, find the real
// composer/send-button/assistant-message elements, and update SELECTORS
// below. This is a one-file, few-line fix, not a redesign.
(function () {
  if (self.__wcGeminiInjected) return;
  self.__wcGeminiInjected = true;

  const { MSG_RUN_PROMPT, MSG_SET_MODEL, STATUS } = self.WC_CONSTANTS;
  const {
    log,
    sendStatus,
    setComposerText,
    submitComposer,
    watchUntilSettled,
    waitForNewNode,
    waitForElement,
    queryAllCandidates,
    startTimeoutFor,
    trySetModel,
    tryAttachMedia,
  } = self.WC_HELPERS;
  const SERVICE = "gemini";
  // Gemini's client bundle can still be hydrating well after chrome.tabs
  // reports the tab "complete" (see waitForElement in content-helpers.js) —
  // give the composer this long to mount before treating it as genuinely
  // missing/stale.
  const COMPOSER_WAIT_MS = 10000;

  const SELECTORS = {
    composer: 'div[contenteditable="true"].ql-editor, div[contenteditable="true"]',
    sendButton: 'button[aria-label*="Send" i]',
    // Only consulted when no composer is found — a stray accounts.google.com
    // or /login link elsewhere in the DOM (account switcher, footer, help
    // menu) is common even while fully signed in, so this must never gate
    // ahead of the composer check.
    loginWall: 'a[href*="ServiceLogin"], button[aria-label*="Sign in" i]',
    // Order matters and must NOT be combined into one comma-separated
    // selector (see queryAllCandidates in content-helpers.js and the
    // identical reasoning in claude.js) — kept as ranked fallbacks so a
    // lingering fragment from one pattern can't win over the other's text.
    assistantMessage: ["message-content", ".model-response-text"],
    // UNVERIFIED — no live look at this menu yet. Gemini shows its current
    // model (e.g. "Gemini Flash") as a dropdown near the top of the page;
    // almost certainly needs fixing against the real DOM (open that
    // dropdown, inspect it, adjust these two lines).
    modelTrigger: '[data-test-id*="model"], [aria-haspopup="menu"][aria-label*="odel" i]',
    modelOption: '[role="menuitemradio"], [role="menuitem"]',
    // UNVERIFIED — no live look at this yet either. Most composers hide a
    // real <input type="file"> behind the attach button; if this doesn't
    // work, open devtools, click the attach button, and find the real
    // element (or the drop-zone it needs a simulated drop on instead).
    fileInput: 'input[type="file"]',
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG_SET_MODEL) {
      trySetModel(SERVICE, SELECTORS, message.preferredModel).finally(() =>
        sendResponse({ ok: true }),
      );
      return true; // keep the channel open for the async sendResponse above
    }
    if (message?.type !== MSG_RUN_PROMPT) return;
    run(message.prompt, message.media).catch((err) => {
      console.error(`[WebCouncile:${SERVICE}] unhandled error`, err);
      sendStatus(SERVICE, STATUS.ERROR, String(err?.message || err));
    });
    sendResponse({ ok: true });
  });

  async function run(prompt, media) {
    log(SERVICE, "run() start");

    const composer = await waitForElement(
      () => document.querySelector(SELECTORS.composer),
      COMPOSER_WAIT_MS,
    );
    if (!composer) {
      if (document.querySelector(SELECTORS.loginWall)) {
        log(SERVICE, "no composer, login wall detected");
        sendStatus(SERVICE, STATUS.NOT_SIGNED_IN, "Not signed in to Gemini.");
      } else {
        log(SERVICE, "no composer, no login wall — selector is stale");
        sendStatus(
          SERVICE,
          STATUS.ERROR,
          "Could not find the Gemini composer (selector may be stale).",
        );
      }
      return;
    }

    if (media && media.length) {
      log(SERVICE, `attaching ${media.length} file(s)`);
      await tryAttachMedia(SERVICE, SELECTORS, media);
      await new Promise((r) => setTimeout(r, 300));
    }

    log(SERVICE, "composer found, inserting prompt");
    setComposerText(composer, prompt);
    await new Promise((r) => setTimeout(r, 150));

    log(SERVICE, "submitting prompt");
    const submitted = await submitComposer(composer, SELECTORS.sendButton);
    if (!submitted) {
      log(SERVICE, "composer never cleared after submit attempts — prompt likely wasn't sent");
      sendStatus(
        SERVICE,
        STATUS.ERROR,
        "Could not submit the prompt (composer didn't clear after several tries).",
      );
      return;
    }

    sendStatus(SERVICE, STATUS.WAITING, "Waiting for response…");

    const countBefore = queryAllCandidates(document, SELECTORS.assistantMessage).length;
    log(SERVICE, "watching for new assistant message, countBefore =", countBefore);
    const node = await waitForNewNode(
      SELECTORS.assistantMessage,
      countBefore,
      startTimeoutFor(prompt),
    );
    if (!node) {
      log(SERVICE, "timed out waiting for a new assistant message node");
      sendStatus(
        SERVICE,
        STATUS.ERROR,
        "Timed out waiting for a response to start.",
      );
      return;
    }

    log(SERVICE, "new message node found, watching until settled");
    watchUntilSettled(document.body, SELECTORS.assistantMessage, 800, (finalText) => {
      log(SERVICE, "settled, final length =", finalText.length);
      sendStatus(SERVICE, STATUS.DONE, finalText);
    });
  }
})();
