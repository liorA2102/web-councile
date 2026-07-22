const {
  MSG_BROADCAST_PROMPT,
  MSG_CONSOLIDATE,
  MSG_OPEN_SESSIONS,
  MSG_NEW_COUNCIL,
  MSG_STATUS_UPDATE,
  PORT_COUNCIL,
  DEFAULT_JUDGE_SERVICE,
  STATUS,
} = window.WC_CONSTANTS;

const TERMINAL_STATES = new Set([
  STATUS.DONE,
  STATUS.ERROR,
  STATUS.NOT_SIGNED_IN,
]);

const STATUS_LABELS = {
  [STATUS.IDLE]: "Idle",
  [STATUS.SENDING]: "Sending…",
  [STATUS.WAITING]: "Waiting…",
  [STATUS.STREAMING]: "Streaming…",
  [STATUS.DONE]: "Done",
  [STATUS.ERROR]: "Error",
  [STATUS.NOT_SIGNED_IN]: "Not signed in",
  [STATUS.NOT_OPEN]: "Opening tab…",
};

const SEAT_LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
const MAIN_SERVICES = Object.keys(SEAT_LABELS);
const DEFAULT_COUNCIL_NAME = "My Council";

const PROMPT_MAX_HEIGHT = 320;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB/file — light safety net, not full validation

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const attachEl = document.getElementById("attach");
const attachInputEl = document.getElementById("attach-input");
const attachmentsEl = document.getElementById("composer-attachments");
const transcriptEl = document.getElementById("transcript");
const newCouncilEl = document.getElementById("new-council");
const councilPickerEl = document.getElementById("council-picker");
const councilPickerBtnEl = document.getElementById("council-picker-btn");
const councilNameEl = councilPickerBtnEl.querySelector('[data-role="council-name"]');
const councilPanelEl = document.getElementById("council-picker-panel");
const councilSearchEl = document.getElementById("council-search");
const councilListEl = document.getElementById("council-list");
const sessionSettingsEl = document.getElementById("session-settings");
const sessionModalEl = document.getElementById("session-modal");
const sessionFormEl = document.querySelector("#session-modal .crm-form");
const sessionCancelEl = document.getElementById("session-cancel");
const settingsCouncilPickerEl = document.getElementById("settings-council-picker");
const settingsCouncilBtnEl = document.getElementById("settings-council-btn");
const settingsCouncilNameEl = settingsCouncilBtnEl.querySelector('[data-role="settings-council-name"]');
const settingsCouncilPanelEl = document.getElementById("settings-council-panel");
const settingsCouncilListEl = document.getElementById("settings-council-list");
const sessionInputs = {
  chatgpt: {
    url: document.getElementById("session-chatgpt"),
    model: document.getElementById("session-chatgpt-model"),
  },
  claude: {
    url: document.getElementById("session-claude"),
    model: document.getElementById("session-claude-model"),
  },
  gemini: {
    url: document.getElementById("session-gemini"),
    model: document.getElementById("session-gemini-model"),
  },
};
const judgeServiceEl = document.getElementById("judge-service");
const judgeUrlEl = document.getElementById("judge-url");
const judgeModelEl = document.getElementById("judge-model");
const crmSettingsEl = document.getElementById("crm-settings");
const crmModalEl = document.getElementById("crm-modal");
const crmUrlEl = document.getElementById("crm-url");
const crmKeyEl = document.getElementById("crm-key");
const crmCancelEl = document.getElementById("crm-cancel");
const crmFormEl = document.querySelector("#crm-modal .crm-form");
const crmSendEl = document.getElementById("crm-send");
const crmDotEl = crmSendEl.querySelector('[data-role="crm-dot"]');
const crmLabelEl = crmSendEl.querySelector('[data-role="crm-label"]');

const rosterButtons = {};
document.querySelectorAll(".member-toggle").forEach((btn) => {
  rosterButtons[btn.dataset.service] = btn;
});

let enabledServices = new Set(MAIN_SERVICES);
let sending = false;
let consolidating = false;
// Which service judges consolidation — cached from storage so consolidate()
// (a synchronous click handler) doesn't need to await a storage read.
let judgeService = DEFAULT_JUDGE_SERVICE;

// Multiple councils can be saved (chrome.storage.local key "councils", a map
// of councilId -> { name, sessionLinks, history }), with "activeCouncilId"
// saying which one is live. Cached here for the same reason judgeService is —
// synchronous UI code (picker rendering, button handlers) shouldn't need to
// await a storage read just to know the current council's name.
let councils = {};
let activeCouncilId = null;

// The focus of the UI is a continuous conversation between you and the
// consolidated verdict — each entry is one round: your prompt, every
// member's answer (visible on demand via the per-turn detail toggle), and
// the judge's consolidated reply. `history` is the active council's full
// conversation; the LAST entry is always the one any in-flight status
// update targets, since sending is disabled while a round is in progress.
let history = [];
let pendingMedia = []; // [{ name, type, dataUrl }] attached to the next prompt

// ---------- composer ----------

function autoGrowPrompt() {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, PROMPT_MAX_HEIGHT) + "px";
}

promptEl.addEventListener("input", autoGrowPrompt);
autoGrowPrompt();

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

sendEl.addEventListener("click", send);

// ---------- attachments ----------

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

attachEl.addEventListener("click", () => attachInputEl.click());

async function addFiles(files) {
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      console.log(`[WebCouncile:council] skipping "${file.name}" — over 20MB`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      pendingMedia.push({ name: file.name, type: file.type, dataUrl });
    } catch (err) {
      console.log("[WebCouncile:council] failed to read file:", err);
    }
  }
  renderAttachments();
}

attachInputEl.addEventListener("change", async () => {
  const files = Array.from(attachInputEl.files || []);
  attachInputEl.value = ""; // allow re-selecting the same file later
  await addFiles(files);
});

// Handles both "screenshot, then paste" (an image with no filename) and
// "copy a file in Finder/Explorer, then paste" (one or more real files) —
// clipboardData surfaces both the same way, as file-kind items. A paste with
// no file items (plain text) is left alone so normal text pasting still works.
promptEl.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length === 0) return;
  e.preventDefault();
  addFiles(files);
});

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  attachmentsEl.hidden = pendingMedia.length === 0;
  pendingMedia.forEach((m, i) => {
    const chip = el("div", "attachment-chip");
    if (m.type && m.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = m.dataUrl;
      img.alt = "";
      chip.appendChild(img);
    }
    chip.appendChild(el("span", "attachment-name", m.name));
    const remove = el("button", "attachment-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${m.name}`);
    remove.addEventListener("click", () => {
      pendingMedia.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(remove);
    attachmentsEl.appendChild(chip);
  });
}

// ---------- roster (which members participate in the next round) ----------

function activeServices() {
  return MAIN_SERVICES.filter((service) => enabledServices.has(service));
}

function applyRoster() {
  MAIN_SERVICES.forEach((service) => {
    rosterButtons[service].setAttribute("aria-pressed", String(enabledServices.has(service)));
  });
  refreshButtons();
  refreshCrmButton();
}

function toggleMember(service) {
  if (sending || consolidating) return;
  if (enabledServices.has(service)) {
    if (enabledServices.size === 1) return; // keep at least one seated
    enabledServices.delete(service);
  } else {
    enabledServices.add(service);
  }
  chrome.storage.local.set({ enabledServices: Array.from(enabledServices) });
  applyRoster();
}

MAIN_SERVICES.forEach((service) => {
  rosterButtons[service].addEventListener("click", () => toggleMember(service));
});

function loadRoster() {
  chrome.storage.local.get(["enabledServices"], (result) => {
    const stored = result.enabledServices;
    if (Array.isArray(stored) && stored.length) {
      const valid = stored.filter((s) => MAIN_SERVICES.includes(s));
      if (valid.length) enabledServices = new Set(valid);
    }
    applyRoster();
  });
}

// ---------- port / status plumbing ----------

// MV3 service workers terminate after ~30s idle. This window is opened once
// and can sit around for a long time between prompts, so the port from an
// earlier session can go stale silently — postMessage on a dead port throws
// rather than firing onDisconnect first. connectPort() is called lazily
// before every send so a dead port gets replaced (which also wakes the
// service worker back up) instead of failing invisibly.
let port = null;

function connectPort() {
  port = chrome.runtime.connect({ name: PORT_COUNCIL });
  port.onMessage.addListener((message) => {
    if (message?.type !== MSG_STATUS_UPDATE) return;
    applyUpdate(message);
  });
  port.onDisconnect.addListener(() => {
    console.log("[WebCouncile:council] port disconnected");
    port = null;
    refreshButtons();
  });
}

connectPort();

function postToPort(message) {
  if (!port) connectPort();
  try {
    port.postMessage(message);
  } catch (err) {
    console.log("[WebCouncile:council] stale port, reconnecting:", err);
    connectPort();
    port.postMessage(message);
  }
}

// ---------- conversation history / transcript ----------

function currentEntry() {
  return history[history.length - 1] || null;
}

function isNearBottom() {
  return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 80;
}

function scrollTranscriptToBottom() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function persistHistory() {
  if (!activeCouncilId) return;
  councils[activeCouncilId] = { ...activeCouncil(), history };
  await persistCouncils();
}

function renderTranscript() {
  const wasNearBottom = isNearBottom();
  transcriptEl.innerHTML = "";
  history.forEach((entry) => transcriptEl.appendChild(renderTurn(entry)));
  if (wasNearBottom) scrollTranscriptToBottom();
}

function renderTurn(entry) {
  const turn = el("div", "turn");
  turn.dataset.id = entry.id;

  const userMsg = el("div", "msg-user", entry.prompt);
  if (entry.media && entry.media.length) {
    const mediaRow = el("div", "msg-user-media");
    entry.media.forEach((m) => {
      if (m.type && m.type.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = m.dataUrl;
        img.alt = m.name;
        mediaRow.appendChild(img);
      } else {
        mediaRow.appendChild(el("span", "file-chip", m.name));
      }
    });
    userMsg.appendChild(mediaRow);
  }
  turn.appendChild(userMsg);

  const services = Object.keys(entry.perModel);
  const doneCount = services.filter((s) => entry.perModel[s].status === STATUS.DONE).length;

  const councilMsg = el("div", "msg-council");

  const head = el("div", "msg-council-head");
  head.appendChild(el("span", "seat-dot"));
  head.appendChild(el("span", "name", "Council"));

  const progress = el("div", "seat-progress");
  services.forEach((s) => {
    const dot = el("span", "seat-dot");
    dot.dataset.service = s;
    dot.dataset.state = entry.perModel[s].status;
    dot.title = `${SEAT_LABELS[s]}: ${STATUS_LABELS[entry.perModel[s].status] || entry.perModel[s].status}`;
    progress.appendChild(dot);
  });
  head.appendChild(progress);

  const toggle = el(
    "button",
    "detail-toggle",
    `${entry.expanded ? "Hide" : "View"} ${services.length} answer${services.length === 1 ? "" : "s"} ${entry.expanded ? "▲" : "▼"}`,
  );
  toggle.type = "button";
  toggle.dataset.action = "toggle-detail";
  head.appendChild(toggle);

  if (entry.consolidated.status === null && doneCount >= 2) {
    const btn = el("button", "btn btn-consolidate consolidate-inline", "⚡ Consolidate");
    btn.type = "button";
    btn.dataset.action = "consolidate";
    head.appendChild(btn);
  }

  councilMsg.appendChild(head);

  const body = el("div", "msg-council-body");
  if (entry.consolidated.status === STATUS.ERROR || entry.consolidated.status === STATUS.NOT_SIGNED_IN) {
    body.classList.add("error");
  }
  if (entry.consolidated.status && !TERMINAL_STATES.has(entry.consolidated.status)) {
    // In progress but no text yet — say so explicitly instead of leaving the
    // body empty, which would otherwise show the same placeholder text used
    // for "not requested yet" and make a stuck run look identical to one
    // that just hasn't started.
    body.textContent = `Deliberating via ${SEAT_LABELS[entry.consolidated.via] || entry.consolidated.via}…`;
  } else if (entry.consolidated.status) {
    body.textContent = entry.consolidated.text || "";
  }
  councilMsg.appendChild(body);

  const detail = el("div", "detail-panel");
  detail.hidden = !entry.expanded;
  services.forEach((s) => {
    const seat = el("div", "mini-seat");
    seat.dataset.service = s;
    const seatHead = el("div", "mini-seat-head");
    seatHead.appendChild(el("span", "seat-dot"));
    seatHead.appendChild(el("span", "name", SEAT_LABELS[s]));
    const statusEl = el("span", "status", STATUS_LABELS[entry.perModel[s].status] || entry.perModel[s].status);
    statusEl.dataset.state = entry.perModel[s].status;
    seatHead.appendChild(statusEl);
    seat.appendChild(seatHead);
    seat.appendChild(el("div", "mini-seat-body", entry.perModel[s].text || ""));
    detail.appendChild(seat);
  });
  councilMsg.appendChild(detail);

  turn.appendChild(councilMsg);
  return turn;
}

// Delegated so per-turn buttons work without re-binding listeners on every
// render (the transcript is fully rebuilt on each update).
transcriptEl.addEventListener("click", (e) => {
  const toggleBtn = e.target.closest('[data-action="toggle-detail"]');
  if (toggleBtn) {
    const entry = findEntry(toggleBtn.closest(".turn")?.dataset.id);
    if (entry) {
      entry.expanded = !entry.expanded;
      renderTranscript();
      persistHistory();
    }
    return;
  }
  const consolidateBtn = e.target.closest('[data-action="consolidate"]');
  if (consolidateBtn) {
    consolidate();
  }
});

function findEntry(id) {
  return history.find((entry) => entry.id === id) || null;
}

function applyUpdate({ service, status, text }) {
  const entry = currentEntry();
  if (!entry) return;

  if (service === "consolidated") {
    entry.consolidated.status = status;
    if (TERMINAL_STATES.has(status)) {
      entry.consolidated.text = text || "";
      consolidating = false;
    }
  } else if (entry.perModel[service]) {
    entry.perModel[service].status = status;
    if (
      status === STATUS.DONE ||
      status === STATUS.STREAMING ||
      status === STATUS.ERROR ||
      status === STATUS.NOT_SIGNED_IN
    ) {
      entry.perModel[service].text = text || "";
    }
    if (
      sending &&
      Object.keys(entry.perModel).every((s) => TERMINAL_STATES.has(entry.perModel[s].status))
    ) {
      sending = false;
      maybeAutoConsolidate(entry);
    }
  } else {
    return;
  }

  renderTranscript();
  refreshButtons();
  refreshCrmButton();
  persistHistory();
}

// Fires once, right as a broadcast round finishes (see the branch above) —
// mirrors the same "at least 2 done" gate the inline Consolidate button
// itself uses. Consolidation is always automatic once a quorum is in.
function maybeAutoConsolidate(entry) {
  if (consolidating) return;
  const doneCount = Object.values(entry.perModel).filter((m) => m.status === STATUS.DONE).length;
  if (doneCount >= 2) consolidate();
}

function refreshButtons() {
  sendEl.disabled = !port || sending || consolidating || activeServices().length === 0;
  MAIN_SERVICES.forEach((service) => {
    rosterButtons[service].disabled = sending || consolidating;
  });
}

function send() {
  const text = promptEl.value.trim();
  if (!text || activeServices().length === 0 || sending || consolidating) return;

  const services = activeServices();
  const entry = {
    id: crypto.randomUUID(),
    prompt: text,
    media: pendingMedia,
    perModel: Object.fromEntries(services.map((s) => [s, { status: STATUS.WAITING, text: "" }])),
    consolidated: { status: null, text: "" },
    expanded: false,
  };
  history.push(entry);

  sending = true;
  renderTranscript();
  scrollTranscriptToBottom();
  refreshButtons();
  refreshCrmButton();
  persistHistory();

  postToPort({ type: MSG_BROADCAST_PROMPT, text, services, media: pendingMedia });

  promptEl.value = "";
  autoGrowPrompt();
  pendingMedia = [];
  renderAttachments();
}

function buildConsolidationPrompt(question, doneServices, entry) {
  const sections = doneServices
    .map((service) => `--- ${SEAT_LABELS[service]} ---\n${entry.perModel[service].text}`)
    .join("\n\n");
  return (
    `You are consolidating answers from multiple AI assistants that were each asked the same question.\n\n` +
    `Original question: "${question}"\n\n${sections}\n\n` +
    `Write ONE consolidated answer: merge the points of agreement, resolve or explicitly flag any disagreements, ` +
    `and present the single best combined response. Answer directly — don't mention that you're consolidating other AIs.`
  );
}

function consolidate() {
  const entry = currentEntry();
  if (!entry || consolidating) return;
  const doneServices = Object.keys(entry.perModel).filter(
    (service) => entry.perModel[service].status === STATUS.DONE,
  );
  if (doneServices.length < 2) return;

  // The judge is its own independent seat (configured in session settings),
  // not "whichever member happens to be done" — it never touches a
  // member's own conversation, so it doesn't need to be one of doneServices.
  const via = judgeService;
  const synthesisPrompt = buildConsolidationPrompt(entry.prompt, doneServices, entry);

  consolidating = true;
  entry.consolidated = { status: STATUS.WAITING, text: "", via };
  renderTranscript();
  refreshButtons();
  persistHistory();

  postToPort({ type: MSG_CONSOLIDATE, prompt: synthesisPrompt, via });
}

// ---------- councils (multiple saved sets of pinned sessions + history) ----------

function loadCouncilsRaw() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["councils", "activeCouncilId"], resolve);
  });
}

function persistCouncils() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ councils, activeCouncilId }, resolve);
  });
}

function activeCouncil() {
  return councils[activeCouncilId] || { name: DEFAULT_COUNCIL_NAME, sessionLinks: {}, history: [] };
}

// Older versions stored each member's pinned link as a plain URL string; now
// it's { url, model } so a preferred model can be pinned alongside it.
// Upgrades any old-shape entries in place; returns true if anything changed.
function normalizeMemberLinks(links) {
  const copy = { ...links };
  let changed = false;
  MAIN_SERVICES.forEach((service) => {
    if (typeof copy[service] === "string") {
      copy[service] = { url: copy[service], model: "" };
      changed = true;
    }
  });
  return { links: copy, changed };
}

// Runs once on load. If a council from before this feature existed (a flat
// "sessionLinks" key) is found, it's migrated into a named council instead
// of silently discarded. If nothing exists at all yet, starts one blank
// council so the app has something to point at out of the box. Also
// upgrades any already-saved councils whose member links are still in the
// old plain-string shape (see normalizeMemberLinks).
async function ensureCouncilsInitialized() {
  const stored = await loadCouncilsRaw();
  councils = stored.councils || {};
  activeCouncilId = stored.activeCouncilId || null;

  let needsSave = false;
  Object.values(councils).forEach((council) => {
    if (!council.sessionLinks) return;
    const { links, changed } = normalizeMemberLinks(council.sessionLinks);
    if (changed) {
      council.sessionLinks = links;
      needsSave = true;
    }
  });

  if (activeCouncilId && councils[activeCouncilId]) {
    if (needsSave) await persistCouncils();
    history = councils[activeCouncilId].history || [];
    return;
  }

  const legacy = await new Promise((resolve) => {
    chrome.storage.local.get(["sessionLinks"], (r) => resolve(r.sessionLinks));
  });
  const id = crypto.randomUUID();
  councils[id] = {
    name: DEFAULT_COUNCIL_NAME,
    sessionLinks: normalizeMemberLinks(legacy || {}).links,
    history: [],
  };
  activeCouncilId = id;
  history = [];
  await persistCouncils();
  chrome.storage.local.remove("sessionLinks");
}

function refreshJudgeCache() {
  judgeService = activeCouncil().sessionLinks?.consolidation?.service || DEFAULT_JUDGE_SERVICE;
}

function renderCouncilPicker(filter = "") {
  councilNameEl.textContent = activeCouncil().name;

  const q = filter.trim().toLowerCase();
  const entries = Object.entries(councils)
    .filter(([, c]) => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  councilListEl.innerHTML = "";
  if (entries.length === 0) {
    councilListEl.appendChild(el("li", "council-list-empty", "No matches"));
    return;
  }
  entries.forEach(([id, c]) => {
    const li = el("li", null, c.name);
    li.classList.toggle("active", id === activeCouncilId);
    li.addEventListener("click", () => selectCouncil(id));
    councilListEl.appendChild(li);
  });
}

// Selecting a council from the picker both switches to it AND opens/focuses
// its pinned tabs — there's no separate "Open council" action anymore. Only
// re-run the reset/reload steps if this actually changes which council is
// active; re-clicking the one you're already on just re-focuses its tabs
// without wiping the conversation you're currently looking at.
async function selectCouncil(id) {
  closeCouncilPicker();
  const switchingCouncil = id !== activeCouncilId;
  if (switchingCouncil) {
    activeCouncilId = id;
    await persistCouncils();
    history = activeCouncil().history || [];
    sending = false;
    consolidating = false;
    renderTranscript();
    scrollTranscriptToBottom();
    refreshButtons();
    refreshCrmButton();
    refreshJudgeCache();
    renderCouncilPicker();
  }
  postToPort({ type: MSG_OPEN_SESSIONS });
}

function openCouncilPicker() {
  councilPanelEl.hidden = false;
  councilSearchEl.value = "";
  renderCouncilPicker();
  councilSearchEl.focus();
}

function closeCouncilPicker() {
  councilPanelEl.hidden = true;
}

councilPickerBtnEl.addEventListener("click", () => {
  if (councilPanelEl.hidden) openCouncilPicker();
  else closeCouncilPicker();
});

councilSearchEl.addEventListener("input", () => renderCouncilPicker(councilSearchEl.value));

document.addEventListener("click", (e) => {
  if (!councilPanelEl.hidden && !councilPickerEl.contains(e.target)) {
    closeCouncilPicker();
  }
});

councilSearchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCouncilPicker();
});

newCouncilEl.addEventListener("click", async () => {
  const suggested = `Council ${Object.keys(councils).length + 1}`;
  const name = window.prompt("Name this council:", suggested);
  if (name === null) return; // cancelled
  const id = crypto.randomUUID();
  councils[id] = { name: name.trim() || suggested, sessionLinks: {}, history: [] };
  activeCouncilId = id;
  history = [];
  sending = false;
  consolidating = false;
  await persistCouncils();
  renderTranscript();
  refreshButtons();
  refreshCrmButton();
  refreshJudgeCache();
  renderCouncilPicker();
  postToPort({ type: MSG_NEW_COUNCIL });
});

// ---------- pinned sessions (settings — editable per council, not just the active one) ----------

function populateSessionFields(links) {
  MAIN_SERVICES.forEach((service) => {
    sessionInputs[service].url.value = links[service]?.url || "";
    sessionInputs[service].model.value = links[service]?.model || "";
  });
  judgeServiceEl.value = links.consolidation?.service || DEFAULT_JUDGE_SERVICE;
  judgeUrlEl.value = links.consolidation?.url || "";
  judgeModelEl.value = links.consolidation?.model || "";
}

// A native <select>'s open dropdown is an OS-level popup, which renders
// glitchy/overlapping inside a small chrome.windows.create({type:"popup"})
// window — same reasoning as the toolbar picker, so this reuses that exact
// custom button+list pattern instead of a <select>.
let settingsEditingCouncilId = null;

function renderSettingsCouncilList() {
  settingsCouncilNameEl.textContent = councils[settingsEditingCouncilId]?.name || "";
  settingsCouncilListEl.innerHTML = "";
  Object.entries(councils)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .forEach(([id, c]) => {
      const li = el("li", null, c.name);
      li.classList.toggle("active", id === settingsEditingCouncilId);
      li.addEventListener("click", () => {
        settingsEditingCouncilId = id;
        renderSettingsCouncilList();
        populateSessionFields(councils[id]?.sessionLinks || {});
        closeSettingsCouncilPicker();
      });
      settingsCouncilListEl.appendChild(li);
    });
}

function openSettingsCouncilPicker() {
  settingsCouncilPanelEl.hidden = false;
}

function closeSettingsCouncilPicker() {
  settingsCouncilPanelEl.hidden = true;
}

settingsCouncilBtnEl.addEventListener("click", () => {
  if (settingsCouncilPanelEl.hidden) openSettingsCouncilPicker();
  else closeSettingsCouncilPicker();
});

document.addEventListener("click", (e) => {
  if (!settingsCouncilPanelEl.hidden && !settingsCouncilPickerEl.contains(e.target)) {
    closeSettingsCouncilPicker();
  }
});

function openSessionSettings() {
  settingsEditingCouncilId = activeCouncilId;
  renderSettingsCouncilList();
  populateSessionFields(activeCouncil().sessionLinks || {});
  sessionModalEl.showModal();
}

sessionSettingsEl.addEventListener("click", openSessionSettings);
sessionCancelEl.addEventListener("click", () => sessionModalEl.close());

sessionFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const editingId = settingsEditingCouncilId;
  const links = {};
  MAIN_SERVICES.forEach((service) => {
    links[service] = {
      url: sessionInputs[service].url.value.trim(),
      model: sessionInputs[service].model.value.trim(),
    };
  });
  links.consolidation = {
    service: judgeServiceEl.value,
    url: judgeUrlEl.value.trim(),
    model: judgeModelEl.value.trim(),
  };
  councils[editingId] = { ...(councils[editingId] || {}), sessionLinks: links };
  await persistCouncils();
  if (editingId === activeCouncilId) judgeService = links.consolidation.service;
  sessionModalEl.close();
});

// ---------- CRM ----------

function loadCrmConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["crmUrl", "crmKey"], (result) => resolve(result));
  });
}

function saveCrmConfig(config) {
  return new Promise((resolve) => {
    chrome.storage.local.set(config, resolve);
  });
}

async function openCrmSettings() {
  const { crmUrl, crmKey } = await loadCrmConfig();
  crmUrlEl.value = crmUrl || "";
  crmKeyEl.value = crmKey || "";
  crmModalEl.showModal();
}

crmSettingsEl.addEventListener("click", openCrmSettings);
crmCancelEl.addEventListener("click", () => crmModalEl.close());

crmFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveCrmConfig({
    crmUrl: crmUrlEl.value.trim(),
    crmKey: crmKeyEl.value.trim(),
  });
  crmModalEl.close();
  refreshCrmButton();
});

function setCrmState(state, label) {
  crmDotEl.dataset.state = state;
  crmLabelEl.textContent = label;
}

async function refreshCrmButton() {
  const { crmUrl } = await loadCrmConfig();
  const entry = currentEntry();
  const hasAnswer =
    !!entry &&
    (entry.consolidated.status === STATUS.DONE ||
      Object.values(entry.perModel).some((m) => m.status === STATUS.DONE));
  crmSendEl.disabled = !hasAnswer;
  crmSendEl.title = crmUrl
    ? "Send the latest answer to your CRM"
    : "Configure a CRM webhook URL first (gear icon)";
}

crmSendEl.addEventListener("click", async () => {
  const { crmUrl, crmKey } = await loadCrmConfig();
  if (!crmUrl) {
    openCrmSettings();
    return;
  }

  const entry = currentEntry();
  if (!entry) return;

  const payload = {
    prompt: entry.prompt,
    consolidatedAnswer: entry.consolidated.status === STATUS.DONE ? entry.consolidated.text : null,
    answers: Object.fromEntries(
      Object.keys(entry.perModel).map((service) => [
        service,
        entry.perModel[service].status === STATUS.DONE ? entry.perModel[service].text : null,
      ]),
    ),
    timestamp: new Date().toISOString(),
  };

  crmSendEl.disabled = true;
  setCrmState("sending", "Syncing…");
  try {
    const res = await fetch(crmUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(crmKey ? { Authorization: `Bearer ${crmKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`CRM responded ${res.status}`);
    setCrmState("done", "Synced ✓");
  } catch (err) {
    console.log("[WebCouncile:council] CRM sync failed:", err);
    setCrmState("error", "Sync failed");
    crmSendEl.title = String(err?.message || err);
  } finally {
    setTimeout(() => {
      setCrmState("idle", "Update CRM");
      refreshCrmButton();
    }, 2500);
  }
});

// ---------- boot ----------

loadRoster();
refreshButtons();
refreshCrmButton();

ensureCouncilsInitialized().then(() => {
  refreshJudgeCache();
  renderCouncilPicker();
  renderTranscript();
  scrollTranscriptToBottom();
  refreshCrmButton();
});
