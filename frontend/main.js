const state = {
  flows: [],
  feed: [],
  onlyRunning: false,
  search: "",
  modeFilter: "all",
  settings: { host: "0.0.0.0", sse_port: 8001, stream_port: 8001, openapi_port: 8003, inspector_public_host: "0.0.0.0" },
  autoStart: false,
  formVisible: false,
  autoStartedSession: false,
  autoStartingFlows: false,
  bootId: null,
  eventsMinimized: true,
  autoStartInspector: false,
  inspectorAutoStarted: false,
  autoStartStartedLogged: false,
  autoStartLogged: false,
  autoStartInspectorStartedLogged: false,
  autoStartInspectorLogged: false,
  persistEvents: false,
  settingsVisible: false,
  inspectorHost: "localhost",
  inspectorRunning: false,
  firstLoadLogged: false,
  toastTimer: null,
  autoStartingInspector: false,
  stoppingAllFlows: false,
  flowBusy: {},
  pasteBusy: false,
  errorsOnly: false,
  autoScroll: true,
  actionsOpen: false,
  lastFlowStart: {},
  lastStartAll: 0,
  failedFlows: {},
  flowErrorCounts: {},
};

function recordFlowError(flow, message) {
  if (!flow || !flow.id) return;
  state.failedFlows = state.failedFlows || {};
  state.flowErrorCounts = state.flowErrorCounts || {};
  state.failedFlows[flow.id] = message;
  state.flowErrorCounts[flow.id] = (state.flowErrorCounts[flow.id] || 0) + 1;
  const count = state.flowErrorCounts[flow.id];
  if (count >= 3) {
    pushFeed("warn", `Flow ${flow.name} failed ${count} times, skipping further auto starts.`);
    showToast(`Flow ${flow.name} blocked after ${count} errors`, "error", 0, true);
  }
}

let formSubmitIntent = "save";

const el = {
  flowList: document.getElementById("flow-list"),
  form: document.getElementById("flow-form"),
  formTitle: document.getElementById("form-title"),
  resetForm: document.getElementById("reset-form"),
  startAll: document.getElementById("start-all"),
  autoStartToggle: document.getElementById("auto-start"),
  formModal: document.getElementById("form-modal"),
  toggleForm: document.getElementById("toggle-form"),
  closeForm: document.getElementById("close-form"),
  eventsPanel: document.getElementById("events-panel"),
  toggleEvents: document.getElementById("toggle-events"),
  settingsModal: document.getElementById("settings-modal"),
  openSettings: document.getElementById("open-settings-panel"),
  closeSettings: document.getElementById("close-settings"),
  persistEventsToggle: document.getElementById("persist-events"),
  autoStartInspectorToggle: document.getElementById("auto-start-inspector"),
  inspectorHost: document.getElementById("inspector-host"),
  // showOnlyRunning: document.getElementById("show-only-running"),
  search: document.getElementById("search"),
  modeFilter: document.getElementById("mode-filter"),
  liveFeed: document.getElementById("live-feed"),
  clearFeed: document.getElementById("clear-feed"),
  toggleInspector: document.getElementById("toggle-inspector"),
  openInspector: document.getElementById("open-inspector"),
  exportFlows: document.getElementById("export-flows"),
  importFlows: document.getElementById("import-flows"),
  importFile: document.getElementById("import-file"),
  actionsMenu: document.getElementById("actions-menu"),
  actionsDropdown: document.getElementById("actions-dropdown"),
  pasteJson: document.getElementById("paste-json"),
  saveStart: document.getElementById("save-start"),
  saveFlow: document.getElementById("save-flow"),
  cancelForm: document.getElementById("cancel-form"),
  routeStatus: document.getElementById("route-status"),
  allowOriginsChips: document.getElementById("allow-origins-chips"),
  allowOriginsEntry: document.getElementById("allow-origins-entry"),
  copyCommand: document.getElementById("copy-command"),
  toast: document.getElementById("toast"),
  statsError: document.getElementById("stat-error"),
  toastMessage: document.getElementById("toast-message"),
  toastClose: document.getElementById("toast-close"),
  stats: {
    running: document.getElementById("stat-running"),
    total: document.getElementById("stat-total"),
    // last: document.getElementById("stat-last"),
  },
};

const field = (id) => document.getElementById(id);

const formatter = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(message || "An error occurred");
  }
  return res.json();
}

function serializeForm() {
  return {
    id: field("flow-id").value || null,
    name: field("name").value.trim(),
    route: normalizeRoute(field("route").value.trim() || field("name").value.trim()),
    description: field("description").value.trim(),
    source_type: field("source_type").value,
    target_type: field("target_type").value,
    sse_url: field("sse_url").value.trim() || null,
    openapi_base_url: field("openapi_base_url").value.trim() || null,
    openapi_spec_url: field("openapi_spec_url").value.trim() || null,
    command: field("command").value.trim() || null,
    args: splitWords(field("args").value),
    env: parseEnv(field("env").value),
    headers: parseHeaders(field("headers").value),
    allow_origins: parseList(field("allow_origins").value),
  };
}

function parseHeaders(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(":");
      return { key: key.trim(), value: rest.join(":").trim() };
    })
    .filter((h) => h.key && h.value);
}

function parseEnv(text) {
  const env = {};
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [key, ...rest] = line.split("=");
      if (key && rest.length) {
        env[key.trim()] = rest.join("=").trim();
      }
    });
  return env;
}

function parseList(text) {
  return text
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function uniqueList(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function isValidOrigin(origin) {
  if (origin === "*" || origin === "null") return true;
  try {
    // URL throws on invalid origins
    const parsed = new URL(origin);
    return Boolean(parsed.protocol && parsed.host);
  } catch (_) {
    return false;
  }
}

function splitWords(text) {
  return text
    .split(" ")
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeRoute(text) {
  if (!text) return "";
  // remove accents, lowercase, replace non-alphanum by hyphen, collapse repeats, trim hyphens
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
}

function renderSectionErrors(sectionId, messages = []) {
  const container = document.getElementById(sectionId);
  if (!container) return;
  if (!messages.length) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = messages.map((msg) => `<div>${msg}</div>`).join("");
}

function updateStatusPill(pill, okText, warnText, ok) {
  if (!pill) return;
  pill.textContent = ok ? okText : warnText;
  pill.classList.toggle("status-pill--ok", ok);
  pill.classList.toggle("status-pill--warn", !ok);
}

function mapServerToForm(server, keyName = "imported") {
  if (!server) return;
  const name = field("name").value.trim() || keyName;
  field("name").value = name;
  if (!field("route").value.trim()) {
    field("route").value = normalizeRoute(name);
  }
  if (server.command) {
    field("source_type").value = "stdio";
    field("command").value = server.command || "";
    field("args").value = Array.isArray(server.args) ? server.args.join(" ") : "";
    const env = server.env || {};
    field("env").value = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  } else if (server.url) {
    const t = server.type || server.transportType;
    const isStream = t === "streamable-http" || (server.url || "").includes("/mcp");
    field("source_type").value = isStream ? "streamable_http" : "sse";
    field("sse_url").value = server.url;
    const headers = server.headers || {};
    if (Array.isArray(server.headers)) {
      // array of single-key objects
      const merged = {};
      server.headers.forEach((h) => Object.assign(merged, h));
      field("headers").value = Object.entries(merged)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
    } else {
      field("headers").value = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
    }
  }
  const allow = server.allow_origins || server.allowOrigins;
  if (allow) {
    const normalized = Array.isArray(allow) ? allow : parseList(String(allow));
    setAllowOrigins(normalized);
  } else {
    validateAllowOrigins();
  }
  syncTransportFields();
  validateRoute();
  validateEnv();
  validateCommand();
}

function updateTargetOptions() {
  const source = field("source_type").value;
  const select = field("target_type");
  if (!select) return;
  let mustChange = false;
  Array.from(select.options).forEach((opt) => {
    const disableSame = opt.value === source;
    const disableStdio = opt.value === "stdio";
    const disabled = disableSame || disableStdio;
    opt.disabled = disabled;
    opt.hidden = disabled;
    if (disabled && select.value === opt.value) {
      mustChange = true;
    }
  });
  if (mustChange || select.value === "stdio") {
    const fallback =
      source === "streamable_http" ? "sse" : source === "sse" ? "streamable_http" : "streamable_http";
    select.value = fallback;
  }
  if (source === "openapi") {
    select.value = "streamable_http";
  }
}

async function loadFlows(log = true, forceLog = false) {
  try {
    const data = await fetchJSON("/api/flows");
    const autoKey = localStorage.getItem("mcp_auto_start") === "1";
    const bootKey = localStorage.getItem("mcp_auto_start_boot");
    const bootId = state.bootId;
    const shouldAuto = autoKey && bootId && !state.autoStartedSession && bootKey !== bootId;
    if (shouldAuto) {
      state.autoStartingFlows = true;
    }
    state.flows = data;
    renderFlows();
    renderStats();
    if (log && (forceLog || !state.firstLoadLogged)) {
      pushFeed("info", `Loaded ${data.length} flows`);
      state.firstLoadLogged = true;
    }
    if (shouldAuto) {
      if (!state.autoStartStartedLogged) {
        pushFeed("info", "Auto-start flows in progress...");
        showToast("Auto-starting flows...", "info", 0, true);
        state.autoStartStartedLogged = true;
      }
      state.autoStartingFlows = true;
      renderStats();
      await startAllFlows(true, true);
      state.autoStartedSession = true;
      sessionStorage.setItem("mcp_auto_started_session", "1");
      sessionStorage.setItem("mcp_auto_started_boot", bootId);
      localStorage.setItem("mcp_auto_start_boot", bootId);
      if (!state.autoStartLogged) {
        pushFeed("info", "Auto-start done");
        showToast("Flows auto-started", "success", 2500);
        state.autoStartLogged = true;
      } else {
        hideToast();
      }
      state.autoStartingFlows = false;
      renderStats();
    }
  } catch (err) {
    pushFeed("error", `Load error: ${err.message}`);
  }
}

async function loadSettings() {
  try {
    const settings = await fetchJSON("/api/settings");
    state.settings = settings;
    if (el.inspectorHost) {
      el.inspectorHost.value = settings.inspector_public_host || "localhost";
    }
  } catch (err) {
    pushFeed("error", `Settings error: ${err.message}`);
  }
}

async function loadStatus() {
  try {
    const status = await fetchJSON("/api/status");
    state.bootId = status.bootId;
  } catch (err) {
    pushFeed("error", `Status error: ${err.message}`);
  }
}

async function saveSettings() {
  // Settings are fixed; no-op
  pushFeed("info", "Ports and host are fixed (SSE:8002, Stream:8001)");
}

function renderStats() {
  const running = state.flows.filter((f) => f.state.running).length;
  const total = state.flows.length;
  const errors = Object.keys(state.failedFlows || {}).length;
  const lastEvent = state.feed[0]?.ts ? formatter.format(new Date(state.feed[0].ts * 1000)) : "—";
  el.stats.running.textContent = running;
  el.stats.total.textContent = total;
  if (el.statsError) {
    el.statsError.textContent = errors;
  }
  // el.stats.last.textContent = lastEvent;
  if (el.startAll) {
    const allRunning = total > 0 && running === total;
    if (state.autoStartingFlows) {
      el.startAll.textContent = "Starting...";
      el.startAll.disabled = true;
      el.startAll.dataset.mode = "start";
      el.startAll.classList.remove("button--danger-outline");
    } else if (state.stoppingAllFlows) {
      el.startAll.textContent = "Stopping...";
      el.startAll.disabled = true;
      el.startAll.dataset.mode = "stop";
      el.startAll.classList.add("button--danger-outline");
    } else {
      el.startAll.textContent = allRunning ? "Stop all" : "Start all";
      el.startAll.disabled = false;
      el.startAll.dataset.mode = allRunning ? "stop" : "start";
      el.startAll.classList.toggle("button--danger-outline", allRunning);
    }
  }
  if (el.pasteJson) {
    el.pasteJson.textContent = state.pasteBusy ? "Pasting..." : "Paste JSON";
    el.pasteJson.disabled = state.pasteBusy;
  }
  if (el.toggleInspector) {
    el.toggleInspector.disabled = state.autoStartingInspector || state.autoStartingFlows;
    el.toggleInspector.checked = state.inspectorRunning;
    el.toggleInspector.closest(".switch")?.classList.toggle("disabled", el.toggleInspector.disabled);
  }
  if (el.actionsDropdown) {
    el.actionsDropdown.classList.toggle("hidden", !state.actionsOpen);
    if (el.actionsMenu) {
      el.actionsMenu.setAttribute("aria-expanded", state.actionsOpen ? "true" : "false");
    }
  }
  if (el.openInspector) {
    el.openInspector.disabled = state.autoStartingInspector || state.autoStartingFlows || !state.inspectorRunning;
  }
  if (el.autoStartToggle) {
    el.autoStartToggle.checked = state.autoStart;
  }
  if (el.persistEventsToggle) {
    el.persistEventsToggle.checked = state.persistEvents;
  }
  if (el.autoStartInspectorToggle) {
    el.autoStartInspectorToggle.checked = state.autoStartInspector;
  }
  const autoScrollToggle = document.getElementById("auto-scroll-feed");
  if (autoScrollToggle) autoScrollToggle.checked = state.autoScroll;
  const errorsOnlyToggle = document.getElementById("errors-only");
  if (errorsOnlyToggle) errorsOnlyToggle.checked = state.errorsOnly;
  if (el.inspectorHost) {
    el.inspectorHost.value = state.inspectorHost || "localhost";
  }
  if (el.formModal) {
    el.formModal.classList.toggle("hidden", !state.formVisible);
  }
  if (el.settingsModal) {
    el.settingsModal.classList.toggle("hidden", !state.settingsVisible);
  }
  if (el.eventsPanel) {
    el.eventsPanel.classList.toggle("minimized", state.eventsMinimized);
    if (el.toggleEvents) {
      el.toggleEvents.textContent = state.eventsMinimized ? "Show" : "Minimize";
    }
  }
}

async function refreshInspectorButton() {
  try {
    const st = await fetchJSON("/api/inspector/state");
    state.inspectorUrl = st.url || null;
    state.inspectorRunning = Boolean(st.running && st.url);
    if (el.toggleInspector) {
      el.toggleInspector.checked = state.inspectorRunning;
    }
    el.openInspector.disabled = !state.inspectorRunning;
    renderFlows();
  } catch {
    state.inspectorUrl = null;
    state.inspectorRunning = false;
    if (el.toggleInspector) {
      el.toggleInspector.checked = false;
    }
    el.openInspector.disabled = true;
    renderFlows();
  }
}

function renderFlows() {
  el.flowList.innerHTML = "";
  let flows = [...state.flows];
  if (state.onlyRunning) {
    flows = flows.filter((f) => f.state.running);
  }
  if (state.modeFilter === "running") {
    flows = flows.filter((f) => f.state.running);
  } else if (state.modeFilter && state.modeFilter.startsWith("source_")) {
    const src = state.modeFilter.replace("source_", "");
    flows = flows.filter((f) => (f.source_type || "").toLowerCase() === src);
  } else if (state.modeFilter && state.modeFilter.startsWith("target_")) {
    const tgt = state.modeFilter.replace("target_", "");
    flows = flows.filter((f) => (f.target_type || f.server_transport || "").toLowerCase() === tgt);
  }
  if (state.search) {
    const term = state.search.toLowerCase();
    flows = flows.filter(
      (f) =>
        f.name.toLowerCase().includes(term) ||
        (f.description || "").toLowerCase().includes(term) ||
        (f.sse_url || "").toLowerCase().includes(term) ||
        (f.command || "").toLowerCase().includes(term)
    );
  }
  flows.sort((a, b) => Number(b.state.running) - Number(a.state.running));
  if (!flows.length) {
    el.flowList.innerHTML = `<div class="empty empty--center">
      <span class="empty__icon">➕</span>
      <p>🧭 No flow configured yet.</p>
      <p class="muted small-text">Flows orchestrate your MCP proxies in real time.</p>
      <div class="empty__actions">
        <button class="button button--primary" id="empty-create">Create your first flow</button>
        <button class="button button--ghost" id="empty-import">Import a flow</button>
      </div>
    </div>`;
    const btn = document.getElementById("empty-create");
    if (btn) {
      btn.addEventListener("click", () => {
        state.formVisible = true;
        renderStats();
      });
    }
    const importBtn = document.getElementById("empty-import");
    if (importBtn && el.importFlows) {
      importBtn.addEventListener("click", () => el.importFlows.click());
    }
    renderStats();
    return;
  }
  flows.forEach((flow) => {
    const card = document.createElement("article");
    card.className = "flow-card";
    const busy = state.flowBusy ? state.flowBusy[flow.id] : null;
    const host =
      flow.target_type === "openapi"
        ? state.settings.inspector_public_host || state.settings.host
        : state.settings.host;
    const port =
      flow.target_type === "streamable_http"
        ? state.settings.stream_port
        : flow.target_type === "openapi"
        ? state.settings.openapi_port
        : state.settings.sse_port;
    const route = flow.route || flow.name;
    const exposedPath =
      flow.target_type === "openapi"
        ? `/${route}`
        : `/${route}/${flow.server_transport === "streamablehttp" ? "mcp" : "sse"}`;
    const exposedUrl = `http://${host}:${port}${exposedPath}`;
    let downstreamLabel;
    if (flow.source_type === "stdio") {
      downstreamLabel = `Stdio server: ${flow.command || "—"}`;
    } else if (flow.source_type === "openapi") {
      downstreamLabel = `OpenAPI source: ${flow.openapi_base_url || "—"}`;
    } else {
      downstreamLabel = `Remote server (${flow.source_type}): ${flow.sse_url || "—"}`;
    }
    const exposedLabel = `Exposed (${flow.target_type || flow.server_transport || "sse"})`;
    const transportChip = `${(flow.source_type || "sse")} → ${(flow.target_type || flow.server_transport || "sse")}`;
    const truncatedUrl = exposedUrl.length > 58 ? `${exposedUrl.slice(0, 54)}…` : exposedUrl;
    const failMessage = state.failedFlows?.[flow.id];
    card.innerHTML = `
      <div class="flow-card__header">
        <div class="flow-card__title">
          <h3>${flow.name}</h3>
          <span class="chip chip--mode">${transportChip}</span>
        </div>
        <div class="flow-card__status-group">
          <span class="status ${failMessage ? "status--error" : flow.state.running ? "status--on" : "status--off"}">
            ${failMessage ? "Error" : flow.state.running ? "Running" : "Stopped"}
          </span>
          <label class="switch switch--compact switch--text auto-start-switch" title="Auto-start">
            <input type="checkbox" data-action="auto-start" data-id="${flow.id}" ${flow.auto_start !== false ? "checked" : ""} ${state.autoStartingFlows ? "disabled" : ""}>
            <span class="slider"></span>
            <span class="switch__label">Auto-start</span>
          </label>
        </div>
      </div>
      <p class="flow-card__description">${flow.description || "No description"}</p>
      ${failMessage ? `<p class="flow-card__error">⚠️ ${failMessage}</p>` : ""}
      <div class="flow-card__meta-grid">
        <div class="meta-cell">
          <p class="muted meta-label">Route</p>
          <p class="meta-value">/${route}</p>
        </div>
        <div class="meta-cell meta-cell--action">
          <p class="muted meta-label">Exposed</p>
          <div class="meta-row">
            <p class="meta-value meta-value--truncate" title="${exposedUrl}">${truncatedUrl}</p>
            <button class="button button--icon button--ghost" data-action="copy-exposed" data-id="${flow.id}" data-url="${exposedUrl}" aria-label="Copy exposed URL">⧉</button>
          </div>
        </div>
        <div class="meta-cell">
          <p class="muted meta-label">Source</p>
          <p class="meta-value">${downstreamLabel}</p>
        </div>
        <div class="meta-cell">
          <p class="muted meta-label">Target</p>
          <p class="meta-value">${exposedLabel}</p>
        </div>
      </div>
      <div class="flow-card__actions">
        ${
          flow.state.running
            ? `<button data-action="stop" class="button button--ghost button--danger-outline" data-id="${flow.id}" ${state.autoStartingFlows || state.stoppingAllFlows || busy === "stop" ? "disabled" : ""}>${busy === "stop" ? "Stopping..." : "Stop"}</button>`
            : `<button data-action="start" class="button button--primary" data-id="${flow.id}" ${state.autoStartingFlows || state.stoppingAllFlows || busy === "start" ? "disabled" : ""}>${busy === "start" ? "Starting..." : "Start"}</button>`
        }
        <button data-action="inspect" class="button button--ghost" data-id="${flow.id}" ${
          flow.state.running && (flow.target_type === "openapi" ? true : state.inspectorRunning)
            ? ""
            : "disabled"
        } ${state.autoStartingFlows ? "disabled" : ""}>Inspector</button>
        <details class="actions-menu">
          <summary class="button button--ghost button--icon" aria-label="More actions">⋯</summary>
          <div class="actions-menu__list">
            <button data-action="edit" class="dropdown__item" data-id="${flow.id}" ${state.autoStartingFlows ? "disabled" : ""}>Edit</button>
            <button data-action="delete" class="dropdown__item dropdown__item--danger" data-id="${flow.id}" ${state.autoStartingFlows ? "disabled" : ""}>Delete</button>
          </div>
        </details>
      </div>
    `;
    card.addEventListener("click", (ev) => handleCardAction(ev, flow));
    el.flowList.appendChild(card);
  });
  renderStats();
}

async function handleCardAction(ev, flow) {
  const button = ev.target.closest("button");
  const autoToggle = ev.target.matches('input[data-action="auto-start"]');
  if (!button && !autoToggle) return;
  if (state.autoStartingFlows || state.stoppingAllFlows) {
    pushFeed("info", "Bulk action in progress, please wait...");
    return;
  }
  if (autoToggle) {
    await updateAutoStart(flow, ev.target.checked);
    return;
  }
  const action = button.dataset.action;
  const now = Date.now();
  if (action === "start") {
    const last = state.lastFlowStart?.[flow.id] || 0;
    if (now - last < 5000) {
      pushFeed("info", `Start already requested for ${flow.name}`);
      return;
    }
    state.lastFlowStart[flow.id] = now;
    if (state.failedFlows && state.failedFlows[flow.id]) {
      delete state.failedFlows[flow.id];
    }
    // reset error counter on new attempt
    if (state.flowErrorCounts) {
      state.flowErrorCounts[flow.id] = 0;
    }
  }
  try {
    if (action === "start") {
      state.flowBusy = state.flowBusy || {};
      state.flowBusy[flow.id] = "start";
      renderFlows();
      await fetchJSON(`/api/flows/${flow.id}/start`, { method: "POST" });
      pushFeed(
        "success",
        `Flow ${flow.name} started -> target ${flow.target_type === "streamable_http" ? "streamable-http" : "sse"}`
      );
    }
    if (action === "stop") {
      state.flowBusy = state.flowBusy || {};
      state.flowBusy[flow.id] = "stop";
      renderFlows();
      await fetchJSON(`/api/flows/${flow.id}/stop`, { method: "POST" });
      pushFeed("info", `Flow ${flow.name} stopped: process terminated, endpoint down`);
    }
    if (action === "delete") {
      if (confirm(`Delete ${flow.name} ?`)) {
        await fetchJSON(`/api/flows/${flow.id}`, { method: "DELETE" });
        state.flows = state.flows.filter((f) => f.id !== flow.id);
        pushFeed("warn", `Flow ${flow.name} deleted`);
        renderFlows();
      }
    }
    if (action === "copy-exposed") {
      const url = button.dataset.url;
      if (url) {
        await navigator.clipboard.writeText(url);
        showToast("Exposed URL copied", "success", 1800);
      }
      return;
    }
    if (action === "edit") {
      fillForm(flow);
    }
    if (action === "inspect") {
      if (flow.target_type === "openapi") {
        const url = buildOpenApiDocsUrl(flow);
        if (url) {
          window.open(url, "_blank");
          pushFeed("success", `Docs OpenAPI pour ${flow.name}`);
        } else {
          pushFeed("error", "URL OpenAPI indisponible");
        }
      } else {
        await ensureInspectorRunning();
        const url = buildInspectorUrl(flow);
        if (url) {
          window.open(url, "_blank");
          pushFeed("success", `Inspector pour ${flow.name}`);
        } else {
          pushFeed("error", "URL Inspector indisponible");
        }
      }
    }
  } catch (err) {
    pushFeed("error", err.message);
    showToast(err.message, "error", 2600);
    if (action === "start") {
      recordFlowError(flow, err.message);
    }
  } finally {
    if (state.flowBusy) {
      delete state.flowBusy[flow.id];
    }
    renderFlows();
    await loadFlows();
  }
}

function fillForm(flow) {
  el.formTitle.textContent = `Edit ${flow.name}`;
  field("flow-id").value = flow.id;
  field("name").value = flow.name;
  field("route").value = flow.route || flow.name;
  field("description").value = flow.description || "";
  field("source_type").value = flow.source_type || "sse";
  field("target_type").value =
    flow.target_type || (flow.server_transport === "streamablehttp" ? "streamable_http" : "sse");
  field("sse_url").value = flow.sse_url || "";
  field("openapi_base_url").value = flow.openapi_base_url || "";
  field("openapi_spec_url").value = flow.openapi_spec_url || "";
  field("command").value = flow.command || "";
  field("args").value = (flow.args || []).join(" ");
  field("env").value = Object.entries(flow.env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  setAllowOrigins(flow.allow_origins || []);
  field("headers").value = (flow.headers || [])
    .map((h) => `${h.key}: ${h.value}`)
    .join("\n");
  updateTargetOptions();
  syncTransportFields();
  state.formVisible = true;
  renderStats();
  validateRoute();
  validateEnv();
  validateCommand();
}

function resetForm() {
  el.formTitle.textContent = "Create a flow";
  el.form.reset();
  field("source_type").value = "sse";
  field("target_type").value = "sse";
  field("route").value = "";
  setAllowOrigins([]);
  updateTargetOptions();
  syncTransportFields();
  renderSectionErrors("basics-errors", []);
  renderSectionErrors("routing-errors", []);
  renderSectionErrors("command-errors", []);
  renderSectionErrors("env-errors", []);
  renderSectionErrors("security-errors", []);
  validateRoute();
  validateEnv();
  validateCommand();
}

function syncTransportFields() {
  const sourceType = field("source_type").value;
  const targetType = field("target_type").value;
  const showSourceUrl = sourceType !== "stdio";
  toggleField("sse_url", showSourceUrl);
  toggleField("headers", showSourceUrl);
  const showCommand = sourceType === "stdio" || targetType === "stdio";
  toggleGroup("command-block", showCommand);
  toggleField("command", showCommand);
  toggleField("args", showCommand);
  toggleGroup("env-group", showCommand);
  toggleGroup("env", showCommand);
  toggleField("allow_origins", showCommand);
  toggleGroup("security-group", showCommand);
  const targetSelect = field("target_type");
  const showOpenApi = sourceType === "openapi";
  toggleField("openapi_base_url", showOpenApi);
  toggleField("openapi_spec_url", showOpenApi);
  // When OpenAPI is selected, force target to streamable_http and lock other options
  if (targetSelect) {
    Array.from(targetSelect.options).forEach((opt) => {
      opt.disabled = showOpenApi && opt.value !== "streamable_http";
    });
    if (showOpenApi) {
      targetSelect.value = "streamable_http";
    }
  }
  if (showOpenApi) {
    toggleField("sse_url", false);
    toggleField("headers", false);
    toggleField("command", false);
    toggleField("args", false);
    toggleField("env", false);
    toggleField("allow_origins", false);
  }
  updateTargetOptions();
  validateCommand();
}

function getFieldWrapper(id) {
  const elField = field(id);
  if (!elField) return null;
  return (
    elField.closest(`[data-field="${id}"]`) ||
    elField.closest(`[data-field-wrapper="${id}"]`) ||
    elField.closest("label") ||
    elField.closest(".grid-2") ||
    elField.parentElement
  );
}

function toggleField(id, visible) {
  const wrapper = getFieldWrapper(id);
  if (wrapper) {
    wrapper.style.display = visible ? "" : "none";
  }
  const divider = document.querySelector(`[data-field-divider="${id}"]`);
  if (divider) {
    divider.style.display = visible ? "" : "none";
  }
}

function toggleGroup(name, visible) {
  const nodes = document.querySelectorAll(`[data-field="${name}"], [data-field-divider="${name}"]`);
  nodes.forEach((n) => {
    n.style.display = visible ? "" : "none";
  });
}

function renderAllowOriginChips() {
  if (!el.allowOriginsChips) return;
  const allowField = field("allow_origins");
  if (!allowField) return;
  const origins = parseList(allowField.value);
  el.allowOriginsChips.innerHTML = "";
  if (!origins.length) {
    const placeholder = document.createElement("span");
    placeholder.className = "muted";
    placeholder.textContent = "Add an origin then press Enter";
    el.allowOriginsChips.appendChild(placeholder);
    return;
  }
  origins.forEach((origin, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const invalid = !isValidOrigin(origin);
    if (invalid) chip.classList.add("invalid");
    const label = document.createElement("span");
    label.textContent = origin;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      const next = origins.filter((_, i) => i !== idx);
      field("allow_origins").value = next.join(", ");
      renderAllowOriginChips();
      validateAllowOrigins();
    });
    chip.appendChild(label);
    chip.appendChild(removeBtn);
    el.allowOriginsChips.appendChild(chip);
  });
}

function setAllowOrigins(list) {
  const allowField = field("allow_origins");
  if (!allowField) return;
  const unique = uniqueList(list);
  allowField.value = unique.join(", ");
  validateAllowOrigins();
}

function addOrigin(origin) {
  const targetInput = field("allow_origins");
  if (!targetInput) return;
  const existing = parseList(targetInput.value);
  const additions = parseList(origin || "");
  const fallback = (origin || "").trim();
  const next = uniqueList([...existing, ...(additions.length ? additions : fallback ? [fallback] : [])]);
  setAllowOrigins(next);
}

function validateAllowOrigins() {
  const allowField = field("allow_origins");
  if (!allowField) return { warnings: [] };
  const origins = parseList(allowField.value);
  const invalid = origins.filter((o) => !isValidOrigin(o));
  renderSectionErrors("security-errors", invalid.map((o) => `Invalid origin: ${o}`));
  // refresh chip classes
  renderAllowOriginChips();
  return { warnings: invalid };
}

function validateEnv() {
  const envText = field("env")?.value || "";
  const lines = envText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const warnings = [];
  lines.forEach((line, idx) => {
    if (!line.includes("=") || line.startsWith("=") || line.endsWith("=")) {
      warnings.push(`Line ${idx + 1}: expected KEY=VALUE`);
    }
  });
  renderSectionErrors("env-errors", warnings);
  return { warnings };
}

function validateRoute() {
  const input = field("route");
  if (!input) return { valid: true, value: "" };
  const normalized = normalizeRoute(input.value);
  input.value = normalized;
  const valid = normalized.length > 0;
  updateStatusPill(el.routeStatus, "Slug ready", "Slug required", valid);
  renderSectionErrors("routing-errors", valid ? [] : ["Route slug is required."]);
  return { valid, value: normalized };
}

function validateCommand() {
  const needsCommand = field("source_type").value === "stdio" || field("target_type").value === "stdio";
  const hasCommand = Boolean(field("command")?.value.trim());
  const errors = !needsCommand || hasCommand ? [] : ["Stdio source requires a command to run."];
  renderSectionErrors("command-errors", errors);
  return { valid: errors.length === 0 };
}

function pushFeed(type, message, ts = Date.now() / 1000) {
  state.feed.unshift({ type, message, ts });
  if (!state.persistEvents) {
    state.feed = state.feed.slice(0, 80);
    localStorage.removeItem("mcp_feed");
  } else {
    try {
      const key = state.bootId ? `mcp_feed_${state.bootId}` : "mcp_feed";
      localStorage.setItem(key, JSON.stringify(state.feed.slice(0, 200)));
    } catch (_) {
      // ignore quota errors
    }
  }
  renderFeed();
  renderStats();
}

function showToast(message, type = "info", duration = 3000, sticky = false) {
  if (!el.toast) return;
  if (el.toastMessage) {
    el.toastMessage.textContent = message;
  } else {
    el.toast.textContent = message;
  }
  el.toast.className = `toast toast--${type}`;
  el.toast.classList.remove("hidden");
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }
  if (!sticky && duration > 0) {
    state.toastTimer = setTimeout(() => {
      el.toast.classList.add("hidden");
    }, duration);
  }
}

function hideToast() {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }
  if (el.toast) {
    el.toast.classList.add("hidden");
  }
}

async function updateAutoStart(flow, value) {
  try {
    const payload = {
      name: flow.name,
      route: flow.route,
      description: flow.description,
      source_type: flow.source_type,
      target_type: flow.target_type,
      sse_url: flow.sse_url,
      openapi_base_url: flow.openapi_base_url,
      openapi_spec_url: flow.openapi_spec_url,
      command: flow.command,
      args: flow.args,
      env: flow.env,
      headers: flow.headers,
      allow_origins: flow.allow_origins,
      auto_start: value,
    };
    await fetchJSON(`/api/flows/${flow.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    pushFeed("info", `Auto-start ${value ? "enabled" : "disabled"} for ${flow.name}`);
    await loadFlows(false, false);
  } catch (err) {
    pushFeed("error", `Failed to update auto-start: ${err.message}`);
  }
}

async function toggleInspector() {
  if (!el.toggleInspector) return;
  const desired = el.toggleInspector.checked;
  el.toggleInspector.disabled = true;
  el.openInspector.disabled = true;
  try {
    const st = await fetchJSON("/api/inspector/state");
    if (!desired && st.running) {
      await fetchJSON("/api/inspector/stop", { method: "POST" });
      pushFeed("info", "Inspector stopped");
    } else if (desired && !st.running) {
      await fetchJSON("/api/inspector/start", { method: "POST", body: JSON.stringify({}) });
      pushFeed("success", "Inspector started, waiting for URL...");
      const url = await waitInspectorUrl();
      state.inspectorUrl = url;
      el.openInspector.disabled = !url;
      if (url) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await new Promise((resolve) => setTimeout(resolve, 2000));
        window.open(url, "_blank");
        pushFeed("success", `Inspector prêt : ${url}`);
      } else {
        pushFeed("warn", "Inspector started but URL not detected");
      }
    }
  } catch (err) {
    pushFeed("error", err.message);
    el.toggleInspector.checked = state.inspectorRunning;
  } finally {
    await refreshInspectorButton();
    el.toggleInspector.disabled = false;
  }
}

async function startAllFlows(silent = false, onlyAuto = false) {
  const now = Date.now();
  if (now - state.lastStartAll < 5000 && !silent) {
    pushFeed("info", "Start all already in progress");
    return;
  }
  if (!silent) {
    showToast("Starting flows...", "info", 0, true);
  }
  state.lastStartAll = now;
  const toStart = state.flows.filter(
    (f) =>
      !f.state.running &&
      (!onlyAuto || f.auto_start !== false) &&
      !(state.failedFlows && state.failedFlows[f.id]) &&
      !(state.flowErrorCounts && state.flowErrorCounts[f.id] >= 3)
  );
  if (!toStart.length) {
    if (!silent) pushFeed("info", "No flow to start");
    return;
  }
  // show starting label on targeted flows
  toStart.forEach((f) => {
    state.flowBusy = state.flowBusy || {};
    state.flowBusy[f.id] = "start";
  });
  renderFlows();
  if (!silent) {
    el.startAll.textContent = onlyAuto ? "Starting auto..." : "Starting...";
    el.startAll.disabled = true;
  }
  for (const flow of toStart) {
    const now = Date.now();
    const last = state.lastFlowStart?.[flow.id] || 0;
    if (now - last < 5000) {
      continue;
    }
    state.lastFlowStart[flow.id] = now;
    try {
      await fetchJSON(`/api/flows/${flow.id}/start`, { method: "POST" });
      if (!silent) pushFeed("info", `Flow ${flow.name} started`);
    } catch (err) {
      pushFeed("error", `Failed to start ${flow.name}: ${err.message}`);
      recordFlowError(flow, err.message);
    }
  }
  // clear busy flags after attempts
  state.flowBusy = {};
  await loadFlows(!silent, false);
  if (!silent) {
    showToast("Flows started", "success", 2400);
  }
}

async function exportFlows() {
  try {
    const data = await fetchJSON("/api/flows/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mcp-flows-export.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    pushFeed("success", "Flows exported");
  } catch (err) {
    pushFeed("error", `Export failed: ${err.message}`);
  }
}

async function importFlows(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const flows = JSON.parse(text);
    await fetchJSON("/api/flows/import", {
      method: "POST",
      body: JSON.stringify({ flows }),
    });
    pushFeed("success", "Flows imported");
    await loadFlows();
  } catch (err) {
    pushFeed("error", `Import failed: ${err.message}`);
  } finally {
    e.target.value = "";
  }
}

function handlePastedJson(text) {
  if (!text) return;
  try {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      // Try to wrap a fragment like `"firecrawl": {...}` into an object
      const trimmed = text.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        parsed = JSON.parse(`{${trimmed}}`);
      } else {
        throw _;
      }
    }
    let server = null;
    let key = "imported";
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      const entries = Object.entries(parsed.mcpServers);
      if (entries.length) {
        [key, server] = entries[0];
      }
    } else if (Array.isArray(parsed)) {
      server = parsed[0];
    } else if (typeof parsed === "object") {
      const entries = Object.entries(parsed);
      if (entries.length === 1 && (entries[0][1]?.command || entries[0][1]?.url)) {
        [key, server] = entries[0];
      } else if (parsed.command || parsed.url) {
        server = parsed;
      } else if (entries.length) {
        [key, server] = entries[0];
      }
    }
    if (!server) {
      pushFeed("error", "No server found in JSON");
      return;
    }
    mapServerToForm(server, key);
    pushFeed("success", `Imported server ${key} into the form`);
  } catch (err) {
    pushFeed("error", `Invalid JSON: ${err.message}`);
  }
}

async function stopAllFlows() {
  state.stoppingAllFlows = true;
  renderStats();
  const toStop = state.flows.filter((f) => f.state.running);
  if (!toStop.length) {
    pushFeed("info", "No flow to stop");
    state.stoppingAllFlows = false;
    renderStats();
    return;
  }
  for (const flow of toStop) {
    try {
      await fetchJSON(`/api/flows/${flow.id}/stop`, { method: "POST" });
      pushFeed("info", `Flow ${flow.name} stopped`);
    } catch (err) {
      pushFeed("error", `Failed to stop ${flow.name}: ${err.message}`);
    }
  }
  await loadFlows(true, false);
  state.stoppingAllFlows = false;
  renderStats();
}

async function waitInspectorUrl(timeout = 10000, interval = 400) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const st = await fetchJSON("/api/inspector/state");
      if (st.running && st.url) {
        return st.url;
      }
    } catch (err) {
      pushFeed("error", err.message);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  // If failed, try to stop any running process to reset state
  try {
    await fetchJSON("/api/inspector/stop", { method: "POST" });
  } catch (_) {
    // ignore
  }
  return null;
}

async function autoStartInspectorIfNeeded() {
  const auto = state.autoStartInspector;
  const bootKey = localStorage.getItem("mcp_auto_start_inspector_boot");
  if (!auto || !state.bootId || state.inspectorAutoStarted || bootKey === state.bootId) return;
  try {
    state.autoStartingInspector = true;
    renderStats();
    if (!state.autoStartInspectorStartedLogged) {
      pushFeed("info", "Auto-start Inspector in progress...");
      showToast("Auto-starting Inspector...", "info", 0, true);
      state.autoStartInspectorStartedLogged = true;
    }
    el.toggleInspector.disabled = true;
    el.openInspector.disabled = true;
    await fetchJSON("/api/inspector/start", { method: "POST", body: JSON.stringify({}) });
    const url = await waitInspectorUrl();
    state.inspectorUrl = url;
    el.openInspector.disabled = !url;
    if (el.toggleInspector) {
      el.toggleInspector.checked = Boolean(url);
    }
    state.inspectorAutoStarted = true;
    sessionStorage.setItem("mcp_auto_started_inspector_boot", state.bootId);
    localStorage.setItem("mcp_auto_start_inspector_boot", state.bootId);
    if (!state.autoStartInspectorLogged) {
      pushFeed("info", "Inspector auto-start done");
      state.autoStartInspectorLogged = true;
    }
    showToast("Inspector auto-started", "success", 2400);
  } catch (err) {
    pushFeed("error", `Auto-start inspector: ${err.message}`);
    showToast(`Inspector start failed: ${err.message}`, "error", 0, true);
  } finally {
    state.autoStartingInspector = false;
    renderStats();
    el.toggleInspector.disabled = false;
    await refreshInspectorButton();
  }
}

async function ensureInspectorRunning() {
  const stateInfo = await fetchJSON("/api/inspector/state");
  if (!stateInfo.running) {
    el.toggleInspector.disabled = true;
    await fetchJSON("/api/inspector/start", { method: "POST", body: JSON.stringify({}) });
    const url = await waitInspectorUrl();
    el.toggleInspector.disabled = false;
    state.inspectorUrl = url;
    el.openInspector.disabled = !url;
    if (el.toggleInspector) {
      el.toggleInspector.checked = Boolean(url);
    }
    return url;
  }
  const url = stateInfo.url || (await waitInspectorUrl());
  state.inspectorUrl = url;
  el.openInspector.disabled = !url;
  return url;
}

function buildInspectorUrl(flow) {
  if (!state.inspectorUrl) return null;
  const baseHost = state.inspectorHost || state.settings.inspector_public_host || "localhost";
  const url = new URL(state.inspectorUrl);
  url.host = `${baseHost}:${url.port || 6274}`;
  if (flow) {
    const isStream = flow.target_type === "streamable_http";
    const isOpenApi = flow.target_type === "openapi";
    const targetPort = isOpenApi ? state.settings.openapi_port : isStream ? state.settings.stream_port : state.settings.sse_port;
    const endpointPath = isOpenApi ? "openapi" : isStream ? "mcp" : "sse";
    const targetHost = isOpenApi
      ? state.settings.inspector_public_host || "host.docker.internal"
      : state.settings.host;
    const targetUrl = `http://${targetHost}:${targetPort}/${flow.route || flow.name}/${endpointPath}`;
    url.searchParams.set("transportType", isOpenApi ? "openapi" : isStream ? "streamable-http" : "sse");
    url.searchParams.set("serverUrl", targetUrl);
  }
  return url.toString();
}

function buildOpenApiDocsUrl(flow) {
  const host = state.settings.inspector_public_host || state.settings.host || "localhost";
  const port = state.settings.openapi_port;
  const route = flow.route || flow.name;
  return `http://${host}:${port}/${route}/docs`;
}

async function openInspectorAction() {
  try {
    const url = state.inspectorRunning ? state.inspectorUrl : await ensureInspectorRunning();
    if (!url) {
      pushFeed("error", "Inspector URL unavailable");
      return;
    }
    window.open(url, "_blank");
  } catch (err) {
    pushFeed("error", err.message);
  }
}

function renderFeed() {
  el.liveFeed.innerHTML = "";
  const items = state.errorsOnly ? state.feed.filter((i) => i.type === "error") : state.feed;
  if (!items.length) {
    el.liveFeed.innerHTML = `<div class="feed-empty">
      <strong>No events yet</strong>
      <span class="muted small-text">Once flows run, logs and events will show up here in real time.</span>
    </div>`;
    return;
  }
  const badgeMap = {
    success: { cls: "info", label: "success" },
    warn: { cls: "warn", label: "warn" },
    error: { cls: "error", label: "error" },
    log: { cls: "log", label: "log" },
    info: { cls: "info", label: "info" },
  };
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = `feed__item feed__item--${item.type}`;
    const badge = badgeMap[item.type] || badgeMap.info;
    row.innerHTML = `
      <div class="feed__row-head">
        <span class="feed__badge feed__badge--${badge.cls}">${badge.label}</span>
        <p class="feed__time">${formatter.format(new Date(item.ts * 1000))}</p>
      </div>
      <p class="feed__message">${item.message}</p>
    `;
    el.liveFeed.appendChild(row);
  });
  if (state.autoScroll) {
    el.liveFeed.scrollTop = el.liveFeed.scrollHeight;
  }
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "log") {
        pushFeed("log", `[${data.flowId}] ${data.line}`, data.ts || Date.now() / 1000);
      }
      if (data.type === "flow_started") {
        pushFeed("success", `Flow ${data.flowId} started (pid ${data.pid})`, Date.now() / 1000);
        refreshFlowState(data.flowId, { running: true, pid: data.pid, port: data.port });
      }
      if (data.type === "flow_stopped") {
        pushFeed("warn", `Flow ${data.flowId} stopped (code ${data.code ?? "?"})`, data.stoppedAt || Date.now() / 1000);
        refreshFlowState(data.flowId, { running: false, exit_code: data.code });
      }
      if (data.type === "flow_exited") {
        pushFeed("warn", `Flow ${data.flowId} exited (code ${data.code ?? "?"})`, data.ts || Date.now() / 1000);
        refreshFlowState(data.flowId, { running: false, exit_code: data.code });
      }
      renderFlows();
    } catch (err) {
      console.error(err);
    }
  };
  es.onerror = () => {
    pushFeed("error", "SSE connection lost, reconnecting...");
    setTimeout(connectEvents, 2000);
  };
}

function refreshFlowState(flowId, newState) {
  const target = state.flows.find((f) => f.id === flowId);
  if (target) {
    target.state = { ...target.state, ...newState };
  }
}

async function handleSubmit(ev) {
  ev.preventDefault();
  const routeCheck = validateRoute();
  const envCheck = validateEnv();
  const corsCheck = validateAllowOrigins();
  const cmdCheck = validateCommand();
  if (!routeCheck.valid) {
    showToast("Route slug is required", "error", 2600);
    field("route").focus();
    return;
  }
  if (!cmdCheck.valid) {
    showToast("Command is required for stdio sources", "error", 2600);
    field("command").focus();
    return;
  }
  const payload = serializeForm();
  try {
    let savedId = payload.id;
    if (payload.id) {
      await fetchJSON(`/api/flows/${payload.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      pushFeed("success", `Flow ${payload.name} updated`);
    } else {
      const created = await fetchJSON("/api/flows", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      pushFeed("success", `Flow ${created.name} created`);
      savedId = created.id;
    }
    if (formSubmitIntent === "start" && savedId) {
      try {
        await fetchJSON(`/api/flows/${savedId}/start`, { method: "POST" });
        pushFeed("success", `Flow ${payload.name || field("name").value} started`);
      } catch (err) {
        pushFeed("error", `Saved but failed to start: ${err.message}`);
      }
    }
    if (envCheck.warnings?.length) {
      showToast("Env warnings: check KEY=VALUE lines", "info", 2400);
    }
    if (corsCheck.warnings?.length) {
      showToast("CORS origins contain invalid URLs", "info", 2600);
    }
    resetForm();
    state.formVisible = false;
    renderStats();
    await loadFlows();
  } catch (err) {
    pushFeed("error", err.message);
  } finally {
    formSubmitIntent = "save";
  }
}

function bindEvents() {
  el.form.addEventListener("submit", handleSubmit);
  el.resetForm.addEventListener("click", resetForm);
  if (el.saveFlow) {
    el.saveFlow.addEventListener("click", () => {
      formSubmitIntent = "save";
    });
  }
  if (el.saveStart) {
    el.saveStart.addEventListener("click", () => {
      formSubmitIntent = "start";
      el.form.requestSubmit();
    });
  }
  if (el.cancelForm) {
    el.cancelForm.addEventListener("click", () => {
      state.formVisible = false;
      renderStats();
    });
  }
  // el.showOnlyRunning.addEventListener("change", (e) => {
  //   state.onlyRunning = e.target.checked;
  //   renderFlows();
  // });
  el.search.addEventListener("input", (e) => {
    state.search = e.target.value;
    renderFlows();
  });
  field("name").addEventListener("blur", () => {
    const nameVal = field("name").value.trim();
    if (!field("route").value.trim() && nameVal.length > 0) {
      field("route").value = normalizeRoute(nameVal);
    }
    validateRoute();
  });
  field("route").addEventListener("input", () => {
    field("route").value = normalizeRoute(field("route").value);
    validateRoute();
  });
  field("route").addEventListener("blur", validateRoute);
  field("env").addEventListener("input", validateEnv);
  el.modeFilter.addEventListener("change", (e) => {
    state.modeFilter = e.target.value;
    renderFlows();
  });
  field("source_type").addEventListener("change", () => {
    syncTransportFields();
    validateCommand();
  });
  field("target_type").addEventListener("change", () => {
    syncTransportFields();
    validateCommand();
  });
  field("command").addEventListener("input", validateCommand);
  el.clearFeed.addEventListener("click", () => {
    state.feed = [];
    renderFeed();
  });
  el.toggleInspector.addEventListener("change", toggleInspector);
  el.openInspector.addEventListener("click", () => {
    state.actionsOpen = false;
    renderStats();
    openInspectorAction();
  });
  if (el.startAll) {
    el.startAll.addEventListener("click", () => {
      if (state.autoStartingFlows || state.stoppingAllFlows) {
        pushFeed("info", "Bulk action in progress, please wait...");
        return;
      }
      const mode = el.startAll.dataset.mode;
      if (mode === "stop") {
        if (confirm("Stop all running flows?")) {
          stopAllFlows();
        }
      } else {
        if (confirm("Start all flows?")) {
          startAllFlows();
        }
      }
    });
  }
  if (el.autoStartToggle) {
    el.autoStartToggle.addEventListener("change", (e) => {
      state.autoStart = e.target.checked;
      localStorage.setItem("mcp_auto_start", state.autoStart ? "1" : "0");
    });
  }
  if (el.toggleForm) {
    el.toggleForm.addEventListener("click", () => {
      state.formVisible = true;
      resetForm();
      renderStats();
    });
  }
  if (el.closeForm) {
    el.closeForm.addEventListener("click", () => {
      state.formVisible = false;
      renderStats();
    });
  }
  if (el.toggleEvents) {
    el.toggleEvents.addEventListener("click", () => {
      state.eventsMinimized = !state.eventsMinimized;
      renderStats();
    });
  }
  if (el.openSettings) {
    el.openSettings.addEventListener("click", () => {
      state.settingsVisible = true;
      renderStats();
    });
  }
  if (el.actionsMenu) {
    el.actionsMenu.addEventListener("click", () => {
      state.actionsOpen = !state.actionsOpen;
      renderStats();
    });
    document.addEventListener("click", (e) => {
      if (state.actionsOpen && !el.actionsMenu.contains(e.target) && !el.actionsDropdown.contains(e.target)) {
        state.actionsOpen = false;
        renderStats();
      }
    });
  }
  if (el.closeSettings) {
    el.closeSettings.addEventListener("click", () => {
      state.settingsVisible = false;
      renderStats();
    });
  }
  // Click outside modals to close
  if (el.settingsModal) {
    el.settingsModal.addEventListener("click", (e) => {
      if (e.target === el.settingsModal) {
        state.settingsVisible = false;
        renderStats();
      }
    });
  }
  if (el.formModal) {
    el.formModal.addEventListener("click", (e) => {
      if (e.target === el.formModal) {
        state.formVisible = false;
        renderStats();
      }
    });
  }
  if (el.autoStartToggle) {
    el.autoStartToggle.addEventListener("change", (e) => {
      state.autoStart = e.target.checked;
      localStorage.setItem("mcp_auto_start", state.autoStart ? "1" : "0");
    });
  }
  if (el.persistEventsToggle) {
    el.persistEventsToggle.addEventListener("change", (e) => {
      state.persistEvents = e.target.checked;
      localStorage.setItem("mcp_persist_events", state.persistEvents ? "1" : "0");
      if (!state.persistEvents) {
        state.feed = [];
        renderFeed();
      }
    });
  }
  if (el.autoStartInspectorToggle) {
    el.autoStartInspectorToggle.addEventListener("change", (e) => {
      state.autoStartInspector = e.target.checked;
      localStorage.setItem("mcp_auto_start_inspector", state.autoStartInspector ? "1" : "0");
    });
  }
  if (el.inspectorHost) {
    el.inspectorHost.addEventListener("input", (e) => {
      state.inspectorHost = e.target.value || "localhost";
      localStorage.setItem("mcp_inspector_host", state.inspectorHost);
    });
  }
  const autoScrollToggle = document.getElementById("auto-scroll-feed");
  if (autoScrollToggle) {
    autoScrollToggle.addEventListener("change", (e) => {
      state.autoScroll = e.target.checked;
    });
  }
  const errorsOnlyToggle = document.getElementById("errors-only");
  if (errorsOnlyToggle) {
    errorsOnlyToggle.addEventListener("change", (e) => {
      state.errorsOnly = e.target.checked;
      renderFeed();
    });
  }
  if (el.exportFlows) {
    el.exportFlows.addEventListener("click", () => {
      state.actionsOpen = false;
      renderStats();
      exportFlows();
    });
  }
  if (el.importFlows && el.importFile) {
    el.importFlows.addEventListener("click", () => {
      state.actionsOpen = false;
      renderStats();
      el.importFile.click();
    });
    el.importFile.addEventListener("change", importFlows);
  }
  if (el.toastClose) {
    el.toastClose.addEventListener("click", hideToast);
  }
  if (el.copyCommand) {
    el.copyCommand.addEventListener("click", async () => {
      const cmd = field("command")?.value?.trim();
      const args = field("args")?.value?.trim();
      const full = [cmd, args].filter(Boolean).join(" ");
      if (!full) {
        showToast("No command to copy", "info", 1800);
        return;
      }
      try {
        await navigator.clipboard.writeText(full);
        showToast("Command copied", "success", 1800);
      } catch (err) {
        pushFeed("error", `Clipboard failed: ${err.message}`);
      }
    });
  }
  if (el.allowOriginsEntry) {
    const commitOrigin = () => {
      addOrigin(el.allowOriginsEntry.value);
      el.allowOriginsEntry.value = "";
    };
    el.allowOriginsEntry.addEventListener("keydown", (e) => {
      if (["Enter", "Tab", ","].includes(e.key)) {
        e.preventDefault();
        commitOrigin();
      }
    });
    el.allowOriginsEntry.addEventListener("blur", commitOrigin);
  }
  if (el.pasteJson) {
    el.pasteJson.addEventListener("click", async () => {
      try {
        state.pasteBusy = true;
        renderStats();
        const text = await navigator.clipboard.readText();
        handlePastedJson(text);
      } catch (err) {
        const manual = prompt("Paste MCP server JSON here:");
        if (manual) handlePastedJson(manual);
      } finally {
        state.pasteBusy = false;
        renderStats();
      }
    });
  }
  // Allow direct paste on the modal background (not when focused in inputs)
  if (el.formModal) {
    el.formModal.addEventListener("paste", (e) => {
      const target = e.target;
      const isField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (isField) return;
      const text = e.clipboardData?.getData("text");
      if (text) {
        e.preventDefault();
        handlePastedJson(text);
      }
    });
  }
}

async function boot() {
  bindEvents();
  resetForm();
  state.autoStart = localStorage.getItem("mcp_auto_start") === "1";
  state.autoStartInspector = localStorage.getItem("mcp_auto_start_inspector") === "1";
  state.inspectorHost = localStorage.getItem("mcp_inspector_host") || "localhost";
  state.settingsVisible = false;
  state.formVisible = false;
  // ensure modals start hidden in DOM
  renderStats();
  await loadStatus();
  state.persistEvents = localStorage.getItem("mcp_persist_events") === "1";
  if (state.persistEvents) {
    const key = state.bootId ? `mcp_feed_${state.bootId}` : "mcp_feed";
    const savedFeed = localStorage.getItem(key);
    if (savedFeed) {
      try {
        state.feed = JSON.parse(savedFeed);
      } catch (_) {
        state.feed = [];
      }
      renderFeed();
    }
  }
  const sessionBoot = sessionStorage.getItem("mcp_auto_started_boot");
  const sessionInspectorBoot = sessionStorage.getItem("mcp_auto_started_inspector_boot");
  state.autoStartedSession =
    sessionStorage.getItem("mcp_auto_started_session") === "1" &&
    sessionBoot &&
    sessionBoot === state.bootId;
  state.inspectorAutoStarted =
    sessionInspectorBoot && state.bootId && sessionInspectorBoot === state.bootId;
  await loadSettings();
  await loadFlows(true, true);
  await autoStartInspectorIfNeeded();
  await refreshInspectorButton();
  connectEvents();
  renderFeed();
}

boot();
