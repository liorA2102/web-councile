// Loaded as a plain (non-module) script by both background.js (via importScripts)
// and content scripts (as the first file in chrome.scripting.executeScript's `files`
// array). Everything hangs off `self` so it's visible regardless of how let/const
// top-level scoping behaves across separately-injected classic scripts.
self.WC_CONSTANTS = {
  SERVICES: {
    chatgpt: {
      label: "ChatGPT",
      url: "https://chatgpt.com/",
      urlPattern: "*://chatgpt.com/*",
      matchHost: (host) => host === "chatgpt.com",
      contentScript: "content-scripts/chatgpt.js",
    },
    claude: {
      label: "Claude",
      url: "https://claude.ai/new",
      urlPattern: "*://claude.ai/*",
      matchHost: (host) => host === "claude.ai",
      contentScript: "content-scripts/claude.js",
    },
    gemini: {
      label: "Gemini",
      url: "https://gemini.google.com/app",
      urlPattern: "*://gemini.google.com/*",
      matchHost: (host) => host === "gemini.google.com",
      contentScript: "content-scripts/gemini.js",
    },
  },

  // Messages: council window -> background
  MSG_BROADCAST_PROMPT: "WC_BROADCAST_PROMPT",

  // Messages: council window -> background. Re-runs `prompt` against the
  // single tab for service `via`, but status updates for that run are
  // relayed back tagged as service "consolidated" instead of `via` — see
  // background.js's relayToCouncil/remapForConsolidation.
  MSG_CONSOLIDATE: "WC_CONSOLIDATE",

  // Messages: background -> content script
  MSG_RUN_PROMPT: "WC_RUN_PROMPT",

  // Messages: background -> content script. Sent once, right after a BRAND
  // NEW chat tab is created (never for a reused/pinned conversation),
  // before MSG_RUN_PROMPT — asks the content script to try to switch that
  // site's own model picker to `preferredModel` (empty string means "pick
  // the most capable/advanced option available").
  MSG_SET_MODEL: "WC_SET_MODEL",

  // Messages: content script -> background -> council window
  MSG_STATUS_UPDATE: "WC_STATUS_UPDATE",

  // Messages: council window -> background. Opens/focuses a tab per seat
  // (3 members + consolidation, when it has a pinned link), using each
  // seat's pinned session URL (chrome.storage.local key "sessionLinks").
  MSG_OPEN_SESSIONS: "WC_OPEN_SESSIONS",

  // Messages: council window -> background. Clears all pinned session links
  // and opens a fresh "new chat" tab for each of the 3 members — starting a
  // brand-new council. The consolidation seat is left to pin itself lazily
  // the first time Consolidate is used against this new council.
  MSG_NEW_COUNCIL: "WC_NEW_COUNCIL",

  DEFAULT_JUDGE_SERVICE: "claude",

  // Port name the council window uses to stay connected to the background
  // service worker for the duration of a broadcast round.
  PORT_COUNCIL: "WC_COUNCIL_PORT",

  STATUS: {
    IDLE: "idle",
    SENDING: "sending",
    WAITING: "waiting",
    STREAMING: "streaming",
    DONE: "done",
    ERROR: "error",
    NOT_SIGNED_IN: "not_signed_in",
    NOT_OPEN: "not_open",
  },
};
