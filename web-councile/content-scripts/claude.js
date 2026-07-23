// Content script for claude.ai.
//
// IMPORTANT: these selectors are best-effort guesses based on durable-ish
// attributes (aria-label, contenteditable, role). Claude's markup changes
// over time — if status never leaves "Waiting…"/"Sending…" or the response
// comes back empty, open devtools on claude.ai, find the real
// composer/send-button/assistant-message elements, and update SELECTORS
// below. This is a one-file, few-line fix, not a redesign.
(function () {
  if (self.__wcClaudeInjected) return;
  self.__wcClaudeInjected = true;

  const { MSG_RUN_PROMPT, MSG_SET_MODEL, STATUS } = self.WC_CONSTANTS;
  const {
    log,
    sendStatus,
    setComposerText,
    pressEnter,
    watchUntilSettled,
    waitForNewNode,
    startTimeoutFor,
    trySetModel,
    tryAttachMedia,
  } = self.WC_HELPERS;
  const SERVICE = "claude";

  const SELECTORS = {
    composer:
      'div[contenteditable="true"].ProseMirror, div[contenteditable="true"]',
    sendButton: 'button[aria-label*="Send" i]',
    // Only consulted when no composer is found — a stray /login link
    // elsewhere in the DOM is common even while fully signed in, so this
    // must never gate ahead of the composer check.
    loginWall: 'button[data-testid="login-button"]',
    assistantMessage: '[data-testid="assistant-message"] , div[data-is-streaming]',
    // UNVERIFIED — no live look at this menu yet. Claude's model picker is
    // typically a button near the composer showing the current model's
    // name; almost certainly needs fixing against the real DOM (open the
    // model picker, inspect it, adjust these two lines).
    modelTrigger: '[data-testid="model-selector-dropdown"]',
    modelOption: '[role="menuitem"], [role="option"]',
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

    const composer = document.querySelector(SELECTORS.composer);
    if (!composer) {
      if (document.querySelector(SELECTORS.loginWall)) {
        log(SERVICE, "no composer, login wall detected");
        sendStatus(SERVICE, STATUS.NOT_SIGNED_IN, "Not signed in to Claude.");
      } else {
        log(SERVICE, "no composer, no login wall — selector is stale");
        sendStatus(
          SERVICE,
          STATUS.ERROR,
          "Could not find the Claude composer (selector may be stale).",
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

    const sendBtn = document.querySelector(SELECTORS.sendButton);
    if (sendBtn) {
      log(SERVICE, "clicking send button");
      sendBtn.click();
    } else {
      log(SERVICE, "no send button found, falling back to Enter keypress");
      pressEnter(composer);
    }

    sendStatus(SERVICE, STATUS.WAITING, "Waiting for response…");

    const countBefore = document.querySelectorAll(
      SELECTORS.assistantMessage,
    ).length;
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
