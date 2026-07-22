// Content script for chatgpt.com.
//
// IMPORTANT: these selectors are best-effort guesses based on durable-ish
// attributes (aria-label, data-testid, role). ChatGPT's markup changes
// fairly often — if status never leaves "Waiting…"/"Sending…" or the
// response comes back empty, open devtools on chatgpt.com, find the real
// composer/send-button/assistant-message elements, and update SELECTORS
// below. This is a one-file, few-line fix, not a redesign.
(function () {
  if (self.__wcChatgptInjected) return;
  self.__wcChatgptInjected = true;

  const { MSG_RUN_PROMPT, MSG_SET_MODEL, STATUS } = self.WC_CONSTANTS;
  const {
    log,
    sendStatus,
    setComposerText,
    pressEnter,
    watchUntilSettled,
    waitForNewNode,
    trySetModel,
  } = self.WC_HELPERS;
  const SERVICE = "chatgpt";

  const SELECTORS = {
    // Order matters and must NOT be combined into one comma-separated
    // selector: querySelector on a comma list returns the first DOM-order
    // match across all alternatives, not "prefer the first listed". When a
    // canvas/writing-surface panel is open it adds its own
    // contenteditable, which can sit earlier in the DOM than
    // #prompt-textarea and win a combined query. findComposer() below tries
    // the ID first, explicitly, before falling back.
    composerCandidates: ['#prompt-textarea', 'div[contenteditable="true"]'],
    sendButton: 'button[data-testid="send-button"]',
    // Only consulted when no composer is found — a stray /auth/login link
    // elsewhere in the DOM is common even while fully signed in, so this
    // must never gate ahead of the composer check.
    loginWall: 'button[data-testid="login-button"]',
    assistantMessage: '[data-message-author-role="assistant"]',
    // UNVERIFIED — no live look at this menu yet. Best-guess based on the
    // "data-testid contains model" convention ChatGPT's UI has used before;
    // almost certainly needs fixing against the real DOM (open the model
    // switcher, inspect it, adjust these two lines).
    modelTrigger: '[data-testid*="model-switcher"]',
    modelOption: '[role="menuitemradio"], [data-testid*="model-switcher"] [role="option"]',
  };

  function findComposer() {
    for (const selector of SELECTORS.composerCandidates) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG_SET_MODEL) {
      trySetModel(SERVICE, SELECTORS, message.preferredModel).finally(() =>
        sendResponse({ ok: true }),
      );
      return true; // keep the channel open for the async sendResponse above
    }
    if (message?.type !== MSG_RUN_PROMPT) return;
    run(message.prompt).catch((err) => {
      console.error(`[WebCouncile:${SERVICE}] unhandled error`, err);
      sendStatus(SERVICE, STATUS.ERROR, String(err?.message || err));
    });
    sendResponse({ ok: true });
  });

  async function run(prompt) {
    log(SERVICE, "run() start");

    const composer = findComposer();
    if (!composer) {
      if (document.querySelector(SELECTORS.loginWall)) {
        log(SERVICE, "no composer, login wall detected");
        sendStatus(SERVICE, STATUS.NOT_SIGNED_IN, "Not signed in to ChatGPT.");
      } else {
        log(SERVICE, "no composer, no login wall — selector is stale");
        sendStatus(
          SERVICE,
          STATUS.ERROR,
          "Could not find the ChatGPT composer (selector may be stale).",
        );
      }
      return;
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
      15000,
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
    watchUntilSettled(document.body, SELECTORS.assistantMessage, 1500, (finalText) => {
      log(SERVICE, "settled, final length =", finalText.length);
      sendStatus(SERVICE, STATUS.DONE, finalText);
    });
  }
})();
