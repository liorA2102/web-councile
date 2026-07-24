importScripts("shared/constants.js");

const {
  SERVICES,
  MSG_BROADCAST_PROMPT,
  MSG_CONSOLIDATE,
  MSG_OPEN_SESSIONS,
  MSG_NEW_COUNCIL,
  MSG_RUN_PROMPT,
  MSG_SET_MODEL,
  MSG_STATUS_UPDATE,
  PORT_COUNCIL,
  DEFAULT_JUDGE_SERVICE,
  STATUS,
} = self.WC_CONSTANTS;

let councilWindowId = null;
let councilPort = null;

// Service key currently being re-run for consolidation (see consolidate()
// below), or null. While set, relayToCouncil() rewrites status updates for
// that service to service "consolidated" so they land on the verdict panel
// instead of overwriting that model's own column.
let consolidationActive = null;

const CONSOLIDATION_TERMINAL = new Set([
  STATUS.DONE,
  STATUS.ERROR,
  STATUS.NOT_SIGNED_IN,
]);

const TAB_LOAD_TIMEOUT_MS = 20000;

// Each service gets its own dedicated window, never focused, so it doesn't
// interrupt whatever the user is doing. Chrome pauses rendering-related
// work like requestAnimationFrame — which these chat sites use internally
// for their own streaming-text rendering — for a *minimized* window or a
// tab that isn't the active one in its window; so 3 services sharing one
// window meant only whichever tab was activated last ever actually finished
// without the user manually clicking over to it. True off-screen placement
// was the first attempt, but chrome.windows.create hard-rejects bounds that
// aren't at least 50% within the visible screen ("Invalid value for
// bounds..."), so full invisibility isn't achievable — this is an on-screen
// window instead, cascaded per seat (see seatWindowBounds) so multiple
// seats don't fully overlap and occlude one another (which would silently
// reintroduce the same throttling).
//
// Width/height deliberately kept desktop-sized rather than small: a first
// attempt at 480x360 caused chatgpt.com/claude.ai to render their
// narrow/compact responsive layout, which uses different DOM structure than
// our selectors expect (composer not found, assistant-message never
// appeared) — Gemini tolerated it, these two didn't. Not visually
// "unobtrusive" at this size, but correctness beats tidiness here.
const SEAT_WINDOW_SIZE = { width: 1100, height: 800 };
const SEAT_WINDOW_ORDER = ["chatgpt", "claude", "gemini", "consolidation"];
const SEAT_WINDOW_CASCADE_STEP = 60;

function seatWindowBounds(storageKey) {
  const index = Math.max(SEAT_WINDOW_ORDER.indexOf(storageKey), 0);
  return {
    left: 20 + index * SEAT_WINDOW_CASCADE_STEP,
    top: 20 + index * SEAT_WINDOW_CASCADE_STEP,
    ...SEAT_WINDOW_SIZE,
  };
}

function log(...args) {
  console.log("[WebCouncile:background]", ...args);
}

chrome.action.onClicked.addListener(async () => {
  if (councilWindowId !== null) {
    try {
      await chrome.windows.update(councilWindowId, { focused: true });
      return;
    } catch (_e) {
      // Window was closed by the user; fall through and make a new one.
      councilWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("council/council.html"),
    type: "popup",
    width: 980,
    height: 700,
  });
  councilWindowId = win.id;
});

chrome.windows.onRemoved.addListener(async (closedId) => {
  if (closedId === councilWindowId) councilWindowId = null;
  const ids = await getIsolatedWindowIds();
  if (ids.delete(closedId)) await persistIsolatedWindowIds(ids);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_COUNCIL) return;
  councilPort = port;
  port.onMessage.addListener((message) => handleCouncilMessage(message));
  port.onDisconnect.addListener(() => {
    if (councilPort === port) councilPort = null;
  });
});

// Content scripts report progress with one-shot runtime messages (they run in
// a different execution context per tab and don't hold a port reference).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== MSG_STATUS_UPDATE) return;
  relayToCouncil(message);
});

function relayToCouncil(message) {
  if (!councilPort) return;
  try {
    councilPort.postMessage(remapForConsolidation(message));
  } catch (_e) {
    councilPort = null;
  }
}

// Every status update — whether synthesized directly in background.js
// (WAITING/SENDING) or relayed from a content script (STREAMING/DONE/etc.)
// — passes through relayToCouncil, so this is the single place that needs
// to know about an in-flight consolidation run.
function remapForConsolidation(message) {
  if (
    message?.type !== MSG_STATUS_UPDATE ||
    message.service !== consolidationActive
  ) {
    return message;
  }
  if (CONSOLIDATION_TERMINAL.has(message.status)) consolidationActive = null;
  return { ...message, service: "consolidated" };
}

function handleCouncilMessage(message) {
  if (message?.type === MSG_BROADCAST_PROMPT) {
    broadcastPrompt(message.text, message.services, message.media);
  } else if (message?.type === MSG_CONSOLIDATE) {
    consolidate(message.via, message.prompt);
  } else if (message?.type === MSG_OPEN_SESSIONS) {
    openSessions();
  } else if (message?.type === MSG_NEW_COUNCIL) {
    newCouncil();
  }
}

// Opens/focuses a tab per seat and brings each to the front, for the user's
// explicit "reopen my council" action (as opposed to the quiet,
// non-focus-stealing tab creation broadcastPrompt/consolidate do on their
// own). Only opens the consolidation seat if it's actually pinned yet —
// unlike the 3 members, it has no "default new chat" to fall back to here.
async function openSessions() {
  const serviceKeys = Object.keys(SERVICES);
  for (let i = 0; i < serviceKeys.length; i++) {
    await focusSeat(serviceKeys[i], SERVICES[serviceKeys[i]], serviceKeys[i], i);
  }
  const judgeService = await getJudgeService();
  if (await getPinnedUrl("consolidation")) {
    await focusSeat(judgeService, SERVICES[judgeService], "consolidation", serviceKeys.length);
  }
}

async function focusSeat(serviceKey, service, storageKey, cascadeIndex = 0) {
  try {
    const { tabId } = await getOrCreateTab(serviceKey, service, storageKey);
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId != null) {
      // Seats live in their own small, cascaded window by default (see
      // seatWindowBounds) so background broadcasts don't interrupt the user
      // — reposition it more prominently too (own cascade offset here so
      // reopening all of them doesn't stack them exactly on top of one
      // another) since the user is explicitly asking to look at it here.
      await chrome.windows.update(tab.windowId, {
        focused: true,
        state: "normal",
        left: 80 + cascadeIndex * 40,
        top: 80 + cascadeIndex * 40,
      });
    }
  } catch (err) {
    log(storageKey, "focusSeat failed:", err);
  }
}

// Opens a fresh "new chat" tab for each member of a brand-new council.
// council.js has already created and activated the (blank) council entry
// before sending this, so there's nothing to clear here — just open tabs.
// Consolidation isn't opened here — it pins itself automatically the first
// time Consolidate is used against this new council (see capturePinnedUrl).
async function newCouncil() {
  for (const serviceKey of Object.keys(SERVICES)) {
    try {
      const service = SERVICES[serviceKey];
      const tab = await chrome.tabs.create({ url: service.url, active: true });
      await waitForTabComplete(tab.id);
      if (tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (err) {
      log(serviceKey, "newCouncil failed:", err);
    }
  }
}

// `services` is the council's current roster (members the user hasn't
// toggled off); falls back to everyone if the caller didn't specify one.
// `media` (optional) is an array of { name, type, dataUrl } attachments —
// only ever sent with the initial broadcast, never with consolidation
// (the judge synthesizes from the visible text answers, not the original
// attachment).
function broadcastPrompt(prompt, services, media) {
  const serviceKeys =
    Array.isArray(services) && services.length
      ? services.filter((key) => SERVICES[key])
      : Object.keys(SERVICES);
  log(
    "broadcast requested:",
    JSON.stringify(prompt).slice(0, 120),
    "-> ",
    serviceKeys.join(", "),
    media?.length ? `+${media.length} attachment(s)` : "",
  );
  for (const serviceKey of serviceKeys) {
    runForService(serviceKey, prompt, serviceKey, media).catch((err) => {
      log(serviceKey, "runForService failed:", err);
      relayToCouncil({
        type: MSG_STATUS_UPDATE,
        service: serviceKey,
        status: STATUS.ERROR,
        text: String(err?.message || err),
      });
    });
  }
}

// Consolidation is its own independent seat — a dedicated session that never
// touches any member's own conversation — so it always runs against
// storageKey "consolidation" regardless of which underlying service is
// judging. `via` (which service judges) is chosen by the user in settings
// (falls back to DEFAULT_JUDGE_SERVICE) and passed in by council.js.
function consolidate(via, prompt) {
  if (!SERVICES[via]) {
    log("consolidate: unknown service", via);
    return;
  }
  log(via, "consolidation requested:", JSON.stringify(prompt).slice(0, 120));
  consolidationActive = via;
  runForService(via, prompt, "consolidation").catch((err) => {
    log(via, "consolidate runForService failed:", err);
    relayToCouncil({
      type: MSG_STATUS_UPDATE,
      service: via,
      status: STATUS.ERROR,
      text: String(err?.message || err),
    });
  });
}

async function runForService(serviceKey, prompt, storageKey = serviceKey, media) {
  const service = SERVICES[serviceKey];

  relayToCouncil({
    type: MSG_STATUS_UPDATE,
    service: serviceKey,
    status: STATUS.WAITING,
    text: "Locating tab…",
  });

  const { tabId, isFresh } = await getOrCreateTab(serviceKey, service, storageKey);
  const urlBeforeSend = (await chrome.tabs.get(tabId).catch(() => null))?.url;
  log(storageKey, "using tabId", tabId, isFresh ? "(fresh chat)" : "(existing conversation)");

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "shared/constants.js",
      "shared/content-helpers.js",
      service.contentScript,
    ],
  });
  log(storageKey, "content script injected");

  // Model switching only ever happens for a genuinely brand-new chat — an
  // existing/reused conversation already has its model locked in from
  // whenever it was first created, so there's nothing to (or that should)
  // change there.
  if (isFresh) {
    const preferredModel = await getPreferredModel(storageKey);
    relayToCouncil({
      type: MSG_STATUS_UPDATE,
      service: serviceKey,
      status: STATUS.SENDING,
      text: "Selecting model…",
    });
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: MSG_SET_MODEL,
        preferredModel,
      });
    } catch (err) {
      log(storageKey, "model selection failed, continuing anyway:", err);
    }
  }

  relayToCouncil({
    type: MSG_STATUS_UPDATE,
    service: serviceKey,
    status: STATUS.SENDING,
    text: "Submitting prompt…",
  });

  await chrome.tabs.sendMessage(tabId, {
    type: MSG_RUN_PROMPT,
    prompt,
    media,
  });
  log(storageKey, "MSG_RUN_PROMPT delivered");

  // These apps only assign a real, permanent conversation URL once a message
  // is actually sent — poll for it to actually change rather than guessing a
  // fixed delay, then pin it so this same session gets reused next time
  // instead of the council reopening a blank "new chat" URL forever.
  capturePinnedUrl(storageKey, tabId, urlBeforeSend);
}

// Compares two chat URLs ignoring query string/hash (session IDs live in the
// path) and a trailing slash, so a saved link still matches the tab even if
// the site appended tracking params or the user copied it with/without a
// trailing slash.
function sameConversation(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (p) => p.replace(/\/+$/, "");
    return ua.origin === ub.origin && norm(ua.pathname) === norm(ub.pathname);
  } catch (_e) {
    return false;
  }
}

// Multiple councils can be saved (chrome.storage.local key "councils", a map
// of councilId -> { name, sessionLinks }); "activeCouncilId" says which one
// is currently in use. council.js owns creating/naming/switching councils —
// these helpers just read/write whichever one is active, and degrade
// gracefully (empty session links, i.e. no pins configured) if council.js
// hasn't initialized one yet.
async function getActiveSessionLinks() {
  const { councils, activeCouncilId } = await chrome.storage.local.get([
    "councils",
    "activeCouncilId",
  ]);
  if (!activeCouncilId || !councils?.[activeCouncilId]) return {};
  return councils[activeCouncilId].sessionLinks || {};
}

// Chained onto sessionLinksWriteQueue rather than run directly: broadcastPrompt
// fires chatgpt/claude/gemini's runForService calls concurrently, and each
// one's capturePinnedUrl->savePinnedUrl->patchActiveSessionLinks call is its
// own independent read-modify-write against chrome.storage.local. Without
// serializing them, one service's read can land before another's write
// completes, and its own write then overwrites that pin — the same race
// council.js's mutateCouncilsStorage guards against, just on the
// background.js side of the same storage key.
let sessionLinksWriteQueue = Promise.resolve();
function patchActiveSessionLinks(patchFn) {
  const run = () =>
    new Promise((resolve) => {
      chrome.storage.local.get(["councils", "activeCouncilId"], ({ councils, activeCouncilId }) => {
        if (!activeCouncilId) {
          resolve(); // no council selected yet; nothing to persist against
          return;
        }
        const all = councils || {};
        const current = all[activeCouncilId] || { name: "Council", sessionLinks: {} };
        current.sessionLinks = patchFn(current.sessionLinks || {});
        all[activeCouncilId] = current;
        chrome.storage.local.set({ councils: all }, resolve);
      });
    });
  sessionLinksWriteQueue = sessionLinksWriteQueue.then(run, run);
  return sessionLinksWriteQueue;
}

// Each seat stores { url, model } — members under their own key ("chatgpt"/
// "claude"/"gemini"), consolidation under "consolidation" as { service, url,
// model } since it's not tied to one fixed service. storageKey selects which.
function seatLinks(sessionLinks, storageKey) {
  return (storageKey === "consolidation" ? sessionLinks.consolidation : sessionLinks[storageKey]) || {};
}

async function getPinnedUrl(storageKey) {
  const raw = seatLinks(await getActiveSessionLinks(), storageKey).url;
  return raw && raw.trim() ? raw.trim() : null;
}

// Every OTHER council's pinned URL for this seat. Tabs are only queried by
// domain (see getOrCreateTab's `service.urlPattern` query), which has no
// notion of which council a tab belongs to — without this, a council with no
// pin yet could silently "reuse" a tab that's actually mid-conversation for
// a different council instead of getting its own fresh chat.
async function getUrlsPinnedByOtherCouncils(storageKey) {
  const { councils, activeCouncilId } = await chrome.storage.local.get([
    "councils",
    "activeCouncilId",
  ]);
  return Object.entries(councils || {})
    .filter(([id]) => id !== activeCouncilId)
    .map(([, council]) => seatLinks(council.sessionLinks || {}, storageKey).url)
    .filter((url) => url && url.trim())
    .map((url) => url.trim());
}

// Empty string means "no preference configured" — content scripts treat
// that as "pick the most capable/advanced option available" by default.
async function getPreferredModel(storageKey) {
  return (seatLinks(await getActiveSessionLinks(), storageKey).model || "").trim();
}

async function getJudgeService() {
  const sessionLinks = await getActiveSessionLinks();
  const service = sessionLinks.consolidation?.service;
  return service && SERVICES[service] ? service : DEFAULT_JUDGE_SERVICE;
}

async function savePinnedUrl(storageKey, url) {
  await patchActiveSessionLinks((links) => {
    if (storageKey === "consolidation") {
      links.consolidation = { ...(links.consolidation || {}), url };
    } else {
      links[storageKey] = { ...(links[storageKey] || {}), url };
    }
    return links;
  });
}

// Polls a tab's URL until it differs from `previousUrl` (real navigation to
// a permanent conversation happened) or `timeoutMs` elapses. Resolves null
// on timeout or if the tab got closed — a fixed short delay was unreliable
// here since some sites take a few seconds to route to the real URL, and
// capturing too early just re-pins the generic "new chat" URL forever.
function waitForUrlChange(tabId, previousUrl, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    (async function poll() {
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (_e) {
        resolve(null); // tab was closed
        return;
      }
      if (tab?.url && tab.url !== previousUrl) {
        resolve(tab.url);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(poll, 500);
    })();
  });
}

// Reads back a tab's real conversation URL after a run and pins it for next
// time — this is what makes "New council" self-pinning: the first real
// message sent to a fresh chat captures its now-permanent conversation URL,
// no manual copy/paste required. Only pins if the URL actually changed from
// before the send — if it never does within the timeout, leaves whatever
// was pinned before untouched rather than overwriting it with a generic one.
async function capturePinnedUrl(storageKey, tabId, urlBeforeSend) {
  const finalUrl = await waitForUrlChange(tabId, urlBeforeSend, 20000);
  if (!finalUrl) {
    log(storageKey, "conversation URL never changed — not pinning");
    return;
  }
  try {
    await savePinnedUrl(storageKey, finalUrl);
    log(storageKey, "auto-pinned session ->", finalUrl);
  } catch (_e) {
    // Storage write failed; nothing more to do.
  }
}

// Window ids we've deliberately created to isolate one service's tab (see
// openIsolatedWindow/ensureIsolatedWindow below). Isolation is tracked by id
// rather than re-inferred each time from "does this tab currently have any
// window-mates?", because broadcastPrompt fires all 3 services' runForService
// calls concurrently: as the first two get popped out one after another, the
// 3rd tab ends up alone in the original window purely by elimination — not
// because it was ever actually isolated. A sibling-count check alone can't
// tell those two cases apart, and would wrongly leave that last tab behind in
// the user's regular (non-isolated, on-screen) window instead of giving it
// its own off-screen one too.
//
// Backed by chrome.storage.session rather than a plain in-memory Set: the
// service worker gets killed after ~30s idle and restarts fresh on the next
// message, which for a normal back-and-forth is basically every round. An
// in-memory Set would forget every seat was already isolated between
// prompts, so ensureIsolatedWindow would pop each tab into a brand-new
// window on every single message — session storage survives worker restarts
// while still clearing when the browser itself closes (stale window ids from
// a previous browser session are never valid to check against anyway).
let isolatedWindowIdsCache = null;

async function getIsolatedWindowIds() {
  if (isolatedWindowIdsCache) return isolatedWindowIdsCache;
  const { isolatedWindowIds } = await chrome.storage.session.get("isolatedWindowIds");
  isolatedWindowIdsCache = new Set(isolatedWindowIds || []);
  return isolatedWindowIdsCache;
}

async function persistIsolatedWindowIds(ids) {
  isolatedWindowIdsCache = ids;
  await chrome.storage.session.set({ isolatedWindowIds: [...ids] });
}

async function markWindowIsolated(windowId) {
  const ids = await getIsolatedWindowIds();
  ids.add(windowId);
  await persistIsolatedWindowIds(ids);
}

// Opens `url` in a brand-new, isolated window (small, cascaded per seat —
// see seatWindowBounds) and returns its tab's id once loaded.
async function openIsolatedWindow(url, storageKey) {
  const win = await chrome.windows.create({
    url,
    focused: false,
    type: "normal",
    ...seatWindowBounds(storageKey),
  });
  await markWindowIsolated(win.id);
  log("isolate", `opened new isolated window ${win.id} at (${win.left}, ${win.top}) for`, url);
  const tab = win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
  await waitForTabComplete(tab.id);
  return tab.id;
}

// Moves `tabId` into its own dedicated off-screen window unless its current
// window is already one we isolated it into ourselves — checked strictly
// against the persisted isolatedWindowIds set (see getIsolatedWindowIds),
// deliberately NOT by re-inspecting "does this window have other tabs right
// now". A tab's original (shared) window is never added to that set, so this
// always moves it out exactly once, regardless of what order concurrent
// sibling isolations happen to finish in, and regardless of how many times
// the service worker has restarted since the tab was first isolated.
async function ensureIsolatedWindow(tabId, storageKey) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const ids = await getIsolatedWindowIds();
  if (ids.has(tab.windowId)) {
    log("isolate", `tab ${tabId} already isolated in window ${tab.windowId}`);
    return;
  }
  const win = await chrome.windows.create({ tabId, focused: false, ...seatWindowBounds(storageKey) });
  await markWindowIsolated(win.id);
  log(
    "isolate",
    `moved tab ${tabId} out of window ${tab.windowId} into new isolated window ${win.id} at (${win.left}, ${win.top})`,
  );
}

// Returns { tabId, isFresh }. isFresh is true only for a genuinely blank,
// just-created chat (no pinned URL existed, so there's nothing to reopen) —
// that's the one case where trying to switch the site's model makes sense;
// a reused tab or a reopened pinned conversation already has messages (and
// therefore an already-locked-in model), so isFresh is false for those.
async function getOrCreateTab(serviceKey, service, storageKey = serviceKey) {
  const pinnedUrl = await getPinnedUrl(storageKey);
  const tabs = await chrome.tabs.query({ url: service.urlPattern });

  if (pinnedUrl) {
    const pinnedTab = tabs.find((t) => t.url && sameConversation(t.url, pinnedUrl));
    if (pinnedTab) {
      log(storageKey, "found pinned session tab, using", pinnedTab.id);
      await ensureIsolatedWindow(pinnedTab.id, storageKey);
      return { tabId: pinnedTab.id, isFresh: false };
    }
    log(storageKey, "pinned session not open, opening", pinnedUrl);
    relayToCouncil({
      type: MSG_STATUS_UPDATE,
      service: serviceKey,
      status: STATUS.NOT_OPEN,
      text: "Opening pinned session…",
    });
    const tabId = await openIsolatedWindow(pinnedUrl, storageKey);
    return { tabId, isFresh: false };
  }

  // Consolidation has no "whichever tab is open" fallback — its whole point
  // is a session dedicated to judging, separate from that service's member
  // tab. With nothing pinned yet, start it fresh; it'll self-pin above.
  if (storageKey !== "consolidation") {
    if (tabs.length > 0) {
      const claimedElsewhere = await getUrlsPinnedByOtherCouncils(storageKey);
      const available = tabs.filter(
        (t) => !t.url || !claimedElsewhere.some((u) => sameConversation(t.url, u)),
      );
      if (available.length > 0) {
        const active = available.find((t) => t.active) || available[0];
        log(storageKey, `found ${tabs.length} existing tab(s), using`, active.id);
        await ensureIsolatedWindow(active.id, storageKey);
        // This tab was picked by elimination, not by a pin — if it already
        // sits on a real, distinct conversation (not the site's own "start a
        // new chat" URL), pin it now rather than waiting for
        // capturePinnedUrl to notice a URL change after the next send, which
        // never happens for an already-permanent URL. Without this, a seat
        // that fell into this fallback path never becomes deterministic:
        // every future round re-picks arbitrarily among however many stray
        // same-site tabs are open, popping whichever one it lands on into
        // yet another isolated window.
        if (active.url && !sameConversation(active.url, service.url)) {
          await savePinnedUrl(storageKey, active.url);
          log(storageKey, "pinned already-open conversation ->", active.url);
        }
        return { tabId: active.id, isFresh: false };
      }
      log(storageKey, `all ${tabs.length} existing tab(s) belong to other councils, opening a new one`);
    } else {
      log(storageKey, "no existing tab, will create one");
    }
  } else {
    log(storageKey, "no pinned judge session yet, starting a fresh one");
  }

  relayToCouncil({
    type: MSG_STATUS_UPDATE,
    service: serviceKey,
    status: STATUS.NOT_OPEN,
    text: "Opening tab…",
  });

  const tabId = await openIsolatedWindow(service.url, storageKey);
  return { tabId, isFresh: true };
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for tab to load"));
    }, TAB_LOAD_TIMEOUT_MS);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
