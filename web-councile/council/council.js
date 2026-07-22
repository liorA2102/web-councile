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

const PROMPT_MAX_HEIGHT = 160;

const promptEl = document.getElementById("prompt");
const sendEl = document.getElementById("send");
const consolidateEl = document.getElementById("consolidate");
const verdictEl = document.querySelector(".verdict");
const verdictToggleEl = document.getElementById("verdict-toggle");
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
const autoConsolidateEl = document.getElementById("auto-consolidate");
const crmSettingsEl = document.getElementById("crm-settings");
const crmModalEl = document.getElementById("crm-modal");
const crmUrlEl = document.getElementById("crm-url");
const crmKeyEl = document.getElementById("crm-key");
const crmCancelEl = document.getElementById("crm-cancel");
const crmFormEl = document.querySelector("#crm-modal .crm-form");
const crmSendEl = document.getElementById("crm-send");
const crmDotEl = crmSendEl.querySelector('[data-role="crm-dot"]');
const crmLabelEl = crmSendEl.querySelector('[data-role="crm-label"]');

const panels = {};
document.querySelectorAll("[data-service]").forEach((el) => {
  const service = el.dataset.service;
  panels[service] = {
    el,
    statusEl: el.querySelector('[data-role="status"]'),
    responseEl: el.querySelector('[data-role="response"]'),
  };
});

const rosterButtons = {};
document.querySelectorAll(".member-toggle").forEach((btn) => {
  rosterButtons[btn.dataset.service] = btn;
});

let enabledServices = new Set(MAIN_SERVICES);
let sending = false;
let consolidating = false;
let lastPrompt = "";
// On by default; persisted independently of any one council so the
// preference carries over when you switch between them.
let autoConsolidate = true;
// Which service judges consolidation — cached from storage so consolidate()
// (a synchronous click handler) doesn't need to await a storage read.
let judgeService = DEFAULT_JUDGE_SERVICE;

// Multiple councils can be saved (chrome.storage.local key "councils", a map
// of councilId -> { name, sessionLinks }), with "activeCouncilId" saying
// which one is live. Cached here for the same reason judgeService is —
// synchronous UI code (picker rendering, button handlers) shouldn't need to
// await a storage read just to know the current council's name.
let councils = {};
let activeCouncilId = null;

// ---------- composer ----------

function autoGrowPrompt() {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, PROMPT_MAX_HEIGHT) + "px";
}

promptEl.addEventListener("input", autoGrowPrompt);
autoGrowPrompt();

// ---------- roster (add/remove council members) ----------

function activeServices() {
  return MAIN_SERVICES.filter((service) => enabledServices.has(service));
}

function applyRoster() {
  MAIN_SERVICES.forEach((service) => {
    const isOn = enabledServices.has(service);
    panels[service].el.classList.toggle("disabled", !isOn);
    rosterButtons[service].setAttribute("aria-pressed", String(isOn));
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

function loadAutoConsolidate() {
  chrome.storage.local.get(["autoConsolidate"], (result) => {
    autoConsolidate = result.autoConsolidate !== false; // unset -> default on
    autoConsolidateEl.checked = autoConsolidate;
  });
}

autoConsolidateEl.addEventListener("change", () => {
  autoConsolidate = autoConsolidateEl.checked;
  chrome.storage.local.set({ autoConsolidate });
});

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

function applyUpdate({ service, status, text }) {
  const panel = panels[service];
  if (!panel) return;

  panel.statusEl.dataset.state = status;
  // The consolidated panel shows a custom "Consolidating via <model>…" label
  // (set when the Consolidate button is clicked) through every transient
  // status of the underlying run; only a terminal status replaces it.
  if (service !== "consolidated" || TERMINAL_STATES.has(status)) {
    panel.statusEl.textContent = STATUS_LABELS[status] || status;
  }

  if (
    status === STATUS.DONE ||
    status === STATUS.STREAMING ||
    status === STATUS.ERROR ||
    status === STATUS.NOT_SIGNED_IN
  ) {
    panel.responseEl.textContent = text || "";
  }
  // Transient states (sending/waiting/not_open) don't overwrite response body.

  if (service === "consolidated" && TERMINAL_STATES.has(status)) {
    consolidating = false;
    setVerdictExpanded(true);
  } else if (
    service !== "consolidated" &&
    sending &&
    activeServices().every((s) => TERMINAL_STATES.has(panels[s].statusEl.dataset.state))
  ) {
    sending = false;
    maybeAutoConsolidate();
  }

  refreshButtons();
  refreshCrmButton();
}

// Fires once, right as a broadcast round finishes (see the branch above) —
// mirrors the same "at least 2 done" gate the Consolidate button itself
// uses, just computed directly rather than read off the button's disabled
// state (which refreshButtons() hasn't recalculated yet at this point).
function maybeAutoConsolidate() {
  if (!autoConsolidate || consolidating) return;
  const doneCount = activeServices().filter(
    (s) => panels[s].statusEl.dataset.state === STATUS.DONE,
  ).length;
  if (doneCount >= 2) consolidate();
}

function refreshButtons() {
  const active = activeServices();
  const doneCount = active.filter(
    (service) => panels[service].statusEl.dataset.state === STATUS.DONE,
  ).length;

  sendEl.disabled = !port || sending || consolidating || active.length === 0;
  consolidateEl.disabled = !port || sending || consolidating || doneCount < 2;

  MAIN_SERVICES.forEach((service) => {
    rosterButtons[service].disabled = sending || consolidating;
  });
}

function resetColumns() {
  for (const service of activeServices()) {
    const panel = panels[service];
    panel.statusEl.dataset.state = STATUS.WAITING;
    panel.statusEl.textContent = STATUS_LABELS[STATUS.WAITING];
    panel.responseEl.textContent = "";
  }
  const verdict = panels.consolidated;
  delete verdict.statusEl.dataset.state;
  verdict.statusEl.textContent = "Awaiting quorum";
  verdict.responseEl.textContent = "";
  consolidating = false;
  setVerdictExpanded(false);
  refreshCrmButton();
}

function send() {
  const text = promptEl.value.trim();
  if (!text || activeServices().length === 0) return;

  lastPrompt = text;
  resetColumns();
  sending = true;
  refreshButtons();
  postToPort({ type: MSG_BROADCAST_PROMPT, text, services: activeServices() });

  promptEl.value = "";
  autoGrowPrompt();
}

function buildConsolidationPrompt(question, doneServices) {
  const sections = doneServices
    .map(
      (service) =>
        `--- ${SEAT_LABELS[service]} ---\n${panels[service].responseEl.textContent}`,
    )
    .join("\n\n");
  return (
    `You are consolidating answers from multiple AI assistants that were each asked the same question.\n\n` +
    `Original question: "${question}"\n\n${sections}\n\n` +
    `Write ONE consolidated answer: merge the points of agreement, resolve or explicitly flag any disagreements, ` +
    `and present the single best combined response. Answer directly — don't mention that you're consolidating other AIs.`
  );
}

function consolidate() {
  const doneServices = activeServices().filter(
    (service) => panels[service].statusEl.dataset.state === STATUS.DONE,
  );
  if (doneServices.length < 2) return;

  // The judge is its own independent seat (configured in session settings),
  // not "whichever member happens to be done" — it never touches a
  // member's own conversation, so it doesn't need to be one of doneServices.
  const via = judgeService;
  const synthesisPrompt = buildConsolidationPrompt(lastPrompt, doneServices);

  consolidating = true;
  const verdict = panels.consolidated;
  verdict.statusEl.dataset.state = STATUS.WAITING;
  verdict.statusEl.textContent = `Consolidating via ${SEAT_LABELS[via]}…`;
  verdict.responseEl.textContent = "";
  setVerdictExpanded(true);
  refreshButtons();

  postToPort({ type: MSG_CONSOLIDATE, prompt: synthesisPrompt, via });
}

function setVerdictExpanded(expanded) {
  verdictEl.dataset.expanded = String(expanded);
  verdictToggleEl.setAttribute("aria-expanded", String(expanded));
}

verdictToggleEl.addEventListener("click", () => {
  setVerdictExpanded(verdictEl.dataset.expanded !== "true");
});

sendEl.addEventListener("click", send);
consolidateEl.addEventListener("click", consolidate);
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// ---------- councils (multiple saved sets of pinned sessions) ----------

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
  return councils[activeCouncilId] || { name: DEFAULT_COUNCIL_NAME, sessionLinks: {} };
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
    return;
  }

  const legacy = await new Promise((resolve) => {
    chrome.storage.local.get(["sessionLinks"], (r) => resolve(r.sessionLinks));
  });
  const id = crypto.randomUUID();
  councils[id] = {
    name: DEFAULT_COUNCIL_NAME,
    sessionLinks: normalizeMemberLinks(legacy || {}).links,
  };
  activeCouncilId = id;
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
    const li = document.createElement("li");
    li.className = "council-list-empty";
    li.textContent = "No matches";
    councilListEl.appendChild(li);
    return;
  }
  entries.forEach(([id, c]) => {
    const li = document.createElement("li");
    li.textContent = c.name;
    li.classList.toggle("active", id === activeCouncilId);
    li.addEventListener("click", () => selectCouncil(id));
    councilListEl.appendChild(li);
  });
}

// Selecting a council from the picker both switches to it AND opens/focuses
// its pinned tabs — there's no separate "Open council" action anymore. Only
// re-run the reset/reload steps if this actually changes which council is
// active; re-clicking the one you're already on just re-focuses its tabs
// without wiping the columns you're currently looking at.
async function selectCouncil(id) {
  closeCouncilPicker();
  const switchingCouncil = id !== activeCouncilId;
  if (switchingCouncil) {
    activeCouncilId = id;
    await persistCouncils();
    resetColumns();
    lastPrompt = "";
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
  councils[id] = { name: name.trim() || suggested, sessionLinks: {} };
  activeCouncilId = id;
  await persistCouncils();
  resetColumns();
  lastPrompt = "";
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
      const li = document.createElement("li");
      li.textContent = c.name;
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

ensureCouncilsInitialized().then(() => {
  refreshJudgeCache();
  renderCouncilPicker();
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
  const hasAnswer =
    panels.consolidated.statusEl.dataset.state === STATUS.DONE ||
    activeServices().some(
      (service) => panels[service].statusEl.dataset.state === STATUS.DONE,
    );
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

  const active = activeServices();
  const payload = {
    prompt: lastPrompt,
    consolidatedAnswer:
      panels.consolidated.statusEl.dataset.state === STATUS.DONE
        ? panels.consolidated.responseEl.textContent
        : null,
    answers: Object.fromEntries(
      MAIN_SERVICES.map((service) => [
        service,
        active.includes(service) &&
        panels[service].statusEl.dataset.state === STATUS.DONE
          ? panels[service].responseEl.textContent
          : null,
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

loadRoster();
loadAutoConsolidate();
refreshButtons();
refreshCrmButton();
