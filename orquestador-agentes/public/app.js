const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let agents = [];
let runs = [];
let config = {};
let currentPlan = null;
let projects = [];
let sessions = []; // sesiones de terminal: {id, cwd, name, startedAt, exited, exitCode}
let lastStatus = null;
// Tokens que lleva gastados Claude Code, leídos de sus transcripts por el servidor
let claudeUsage = null;
const agentState = {}; // id -> {status, taskLabel, lastDuration, count}

let activeSessionId = null;
let consoleAgentId = null;
let selectedParallel = 1;
// Cuántas delegaciones corren y cuántas esperan turno, según el servidor
let queueInfo = { active: 0, queued: 0, max_parallel: 1, models: [] };
const expandedAgents = new Set();

const PARALLEL_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

// Un run espera turno ("queued") antes de correr: las dos cuentan como activas
const isActive = (run) => run.status === "queued" || run.status === "running";
const WIDE_TABS = ["mapa", "agentes", "consola", "conexion"];

// ================= API =================
async function api(url, body, method) {
  const hasBody = body !== undefined;
  const res = await fetch(url, {
    method: method || (hasBody ? "POST" : "GET"),
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ================= Tabs =================
function showTab(tab) {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
  $("#app").classList.toggle("wide", WIDE_TABS.includes(tab));
  dockTerminal(tab);
  // El canvas del mapa y Monaco solo se pueden medir cuando son visibles
  if (tab === "mapa") requestAnimationFrame(() => CodeMap.open());
  if (tab === "editor") requestAnimationFrame(() => CodeEditor.open());
}

// La terminal es una sola instancia de xterm: en vez de duplicarla, el nodo
// #terminalHost se muda entre el dock del carril derecho (visible desde
// cualquier pestaña) y el panel grande de la pestaña Sesión.
function dockTerminal(tab) {
  const host = $("#terminalHost");
  const full = tab === "sesion";
  const target = full ? $("#sessionTerminalSlot") : $("#dockBody");
  if (host.parentElement !== target) {
    if (full) target.appendChild(host);
    else target.insertBefore(host, $("#dockEmpty"));
  }
  $("#terminalDock").classList.toggle("elsewhere", full);
  $("#dockAway").hidden = !full;
  requestAnimationFrame(fitTerminal);
}

$$(".tab-btn").forEach((btn) => btn.addEventListener("click", () => showTab(btn.dataset.tab)));

// ================= Render: plan (kanban) =================
// Las mismas cinco columnas que el servidor (kanban.js). El glifo es solo
// adorno: lo que manda es la clase de la columna, que trae su color.
const KANBAN_COLUMNS = [
  ["todo", "TODO", "▤"],
  ["progress", "EN PROGRESO", "◐"],
  ["review", "REVISIÓN", "◉"],
  ["done", "HECHO", "✓"],
  ["approved", "APROBADO", "✓✓"],
];
const DONE_COLUMNS = ["done", "approved"];
// Id de la tarjeta que se está arrastrando. Mientras haya una, el tablero no se
// vuelve a dibujar: un plan:update a media arrastrada la dejaría caer al vacío.
let draggingId = null;
let planDirty = false;

function renderPlan() {
  // Redibujar mientras arrastras dejaría la tarjeta caer al vacío: se aplaza
  if (draggingId) {
    planDirty = true;
    return;
  }
  planDirty = false;
  $("#planEndpoint").textContent = `POST http://localhost:${config.app_port || 3131}/api/plan`;
  // El tablero se ve siempre: aunque Claude Code no haya registrado un plan,
  // puedes escribir tarjetas a mano y la primera crea el tablero en el servidor.
  const steps = currentPlan ? currentPlan.steps : [];
  $("#planEmpty").hidden = !!currentPlan;
  $("#planHead").hidden = !currentPlan;

  if (currentPlan) {
    const project = projects.find((p) => p.path === currentPlan.project);
    const goalParts = [currentPlan.goal, project?.branch ? `⑂ ${project.branch}` : null].filter(Boolean);
    $("#planTitle").textContent = currentPlan.title;
    $("#planGoal").textContent = goalParts.join(" · ");
  }

  const total = steps.length;
  const done = steps.filter((s) => DONE_COLUMNS.includes(columnOf(s))).length;
  $("#planBar").style.width = `${total ? (done / total) * 100 : 0}%`;
  $("#planCount").textContent = `${done}/${total} tarjetas`;

  const board = $("#kanban");
  board.innerHTML = "";
  KANBAN_COLUMNS.forEach(([column, title, glyph]) => {
    const inColumn = steps.filter((s) => columnOf(s) === column).sort(bySort);
    const col = document.createElement("div");
    col.className = `kcol ${column}`;
    col.innerHTML = `
      <div class="kcol-head">
        <span class="cdot"></span>
        <span class="cglyph">${glyph}</span>
        <span class="ctitle">${title}</span>
        <span class="ccount">${inColumn.length}</span>
      </div>
      <div class="kcol-body"></div>
      <button class="kadd">+ Agregar la tarea</button>
    `;
    const body = col.querySelector(".kcol-body");
    if (inColumn.length === 0) body.innerHTML = '<span class="kcol-empty">Sin tareas</span>';
    inColumn.forEach((step) => body.appendChild(renderStepCard(step)));
    col.querySelector(".kadd").addEventListener("click", () => openNewCard(col, column));
    wireDropTarget(body, column);
    board.appendChild(col);
  });

  renderProjects();
}

// El servidor manda 'column'; los planes guardados de antes solo tenían 'status'
const columnOf = (step) => step.column || LEGACY_TO_COLUMN[step.status] || "todo";
const LEGACY_TO_COLUMN = { pending: "todo", queued: "todo", running: "progress", error: "review" };
const bySort = (a, b) => (a.sort ?? a.order ?? 0) - (b.sort ?? b.order ?? 0);

// ---- Arrastrar y soltar ----
// Sin librería: la API nativa de HTML5 basta y el orden lo recalcula el servidor.
function wireDropTarget(body, column) {
  body.addEventListener("dragover", (e) => {
    if (!draggingId) return;
    e.preventDefault();
    body.classList.add("drop-over");
  });
  body.addEventListener("dragleave", () => body.classList.remove("drop-over"));
  body.addEventListener("drop", async (e) => {
    e.preventDefault();
    body.classList.remove("drop-over");
    const id = draggingId || e.dataTransfer.getData("text/plain");
    if (!id) return;
    const index = dropIndex(body, e.clientY);
    draggingId = null;
    try {
      await api(`/api/plan/step/${id}/move`, { column, index });
    } catch (err) {
      alert(err.message);
      renderPlan(); // el servidor manda: si rechazó el movimiento, se deshace
    }
  });
}

// Posición donde cae la tarjeta: la primera cuya mitad queda por debajo del cursor
function dropIndex(body, y) {
  const cards = [...body.querySelectorAll(".kcard:not(.dragging)")];
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return cards.length;
}

// ---- Tarjeta nueva escrita a mano ----
function openNewCard(col, column) {
  if (col.querySelector(".knew")) return;
  const box = document.createElement("div");
  box.className = "knew";
  box.innerHTML = '<textarea rows="2" placeholder="¿Qué hay que hacer?"></textarea>';
  col.querySelector(".kcol-body").appendChild(box);
  const input = box.querySelector("textarea");
  input.focus();

  // Quitar el cuadro dispara su propio blur: sin este cerrojo, Enter crearía
  // la tarjeta dos veces
  let closed = false;
  const close = () => {
    closed = true;
    box.remove();
  };
  const save = async () => {
    if (closed) return;
    const description = input.value.trim();
    close();
    if (!description) return;
    try {
      await api("/api/plan/tasks", { description, column });
    } catch (err) {
      alert(err.message);
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") close();
  });
  input.addEventListener("blur", save);
}

function renderStepCard(step) {
  const agent = agents.find((a) => a.id === step.agent);
  const column = columnOf(step);
  const card = document.createElement("div");
  card.className = `kcard ${column}${step.error ? " failed" : ""}`;
  card.draggable = true;

  const who = step.agent
    ? `<span class="who">${agent?.emoji || "🤖"} ${escapeHtml(agent?.name || step.agent)}</span>`
    : `<span class="who ${step.manual ? "mine" : "claude"}">${step.manual ? "✎ Tuya" : "◈ Claude Code"}</span>`;

  const meta = [];
  if (column === "progress") meta.push(step.agent ? "escribiendo…" : "en curso");
  if (step.durationMs) meta.push(formatSeconds(step.durationMs));
  if (step.error && !step.note) meta.push("error");
  if (step.note) meta.push(step.note);

  card.innerHTML = `
    <span class="kdesc">${escapeHtml(step.description)}</span>
    <div class="kmeta">
      <span class="knum">#${step.order}</span>
      ${who}
      ${meta.length ? `<span class="kmeta-text">${escapeHtml(meta.join(" · "))}</span>` : ""}
      <button class="kdel" title="Quitar del tablero">✕</button>
    </div>
  `;

  card.addEventListener("dragstart", (e) => {
    draggingId = step.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", step.id);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  card.addEventListener("dragend", () => {
    draggingId = null;
    card.classList.remove("dragging");
    if (planDirty) renderPlan(); // se aplazaron los cambios mientras arrastrabas
  });

  card.querySelector(".kdel").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`¿Quitar "${step.description}" del tablero?`)) return;
    try {
      await api(`/api/plan/step/${step.id}`, undefined, "DELETE");
    } catch (err) {
      alert(err.message);
    }
  });

  if (step.runId) {
    card.classList.add("clickable");
    card.addEventListener("click", (e) => {
      if (e.target.closest(".kdel")) return;
      openRunModal(step.runId);
    });
  }
  return card;
}

// ================= SSE (tiempo real) =================
function connectStream() {
  const es = new EventSource("/api/stream");

  es.addEventListener("run:start", (e) => {
    const run = JSON.parse(e.data);
    runs.unshift(run);
    setAgentState(run.agentId, { status: "working", taskLabel: run.meta?.task_label || truncate(run.prompt, 60) });
    renderAgents();
    renderTimeline();
    renderKpis();
  });

  // Se parchea el DOM de cada vista sin re-renderizar, para que el streaming fluya
  es.addEventListener("run:token", (e) => {
    const { id, partial, reasoning } = JSON.parse(e.data);
    const run = runs.find((r) => r.id === id);
    if (!run) return;
    run.response = partial;
    run.reasoning = reasoning || "";
    updateRunStream(run);
    const peek = document.querySelector(`[data-peek="${id}"]`);
    if (peek) peek.textContent = peekText(run);
    if (modalRunId === id) updateModalStream(run);
  });

  es.addEventListener("run:update", (e) => {
    const updated = JSON.parse(e.data);
    const idx = runs.findIndex((r) => r.id === updated.id);
    if (idx >= 0) runs[idx] = updated;
    else runs.unshift(updated);

    const st = agentState[updated.agentId] || {};
    setAgentState(updated.agentId, {
      status:
        updated.status === "running"
          ? "working"
          : updated.status === "queued"
          ? "queued"
          : updated.status === "error"
          ? "error"
          : "idle",
      taskLabel: st.taskLabel,
      lastDuration: updated.durationMs,
      count: (st.count || 0) + (updated.status === "done" ? 1 : 0),
    });
    renderAgents();
    renderTimeline();
    renderKpis();
    if (modalRunId === updated.id) openRunModal(updated.id);
  });

  es.addEventListener("plan:new", (e) => {
    currentPlan = JSON.parse(e.data);
    renderPlan();
  });

  es.addEventListener("plan:update", (e) => {
    currentPlan = JSON.parse(e.data);
    renderPlan();
  });

  es.addEventListener("plan:cleared", () => {
    currentPlan = null;
    renderPlan();
  });

  es.addEventListener("agents:updated", (e) => {
    agents = JSON.parse(e.data);
    renderAgents();
    renderConsoleAgents();
    renderInstructions();
  });

  // Claude Code no pasa por el orquestador: su gasto lo lee el servidor de los
  // transcripts y lo empuja aquí cada vez que cambia
  es.addEventListener("claude:usage", (e) => {
    claudeUsage = JSON.parse(e.data);
    renderClaudeUsage();
    renderKpis();
  });

  es.addEventListener("queue:updated", (e) => {
    queueInfo = JSON.parse(e.data);
    renderKpis();
  });

  es.addEventListener("runs:cleared", () => {
    runs = [];
    renderTimeline();
    renderKpis();
  });

  es.addEventListener("projects:updated", (e) => {
    projects = JSON.parse(e.data);
    renderProjects();
    if (currentPlan) renderPlan();
    renderSessionUI();
  });

  es.addEventListener("terminals:updated", (e) => {
    sessions = JSON.parse(e.data);
    // Si la sesión visible desapareció, pasar a otra abierta
    if (activeSessionId && !sessions.some((s) => s.id === activeSessionId)) {
      const next = sessions.find((s) => !s.exited) || sessions[0];
      if (next) attachSession(next.id);
      else detachTerminal();
    }
    renderSessionUI();
    renderProjects();
    renderKpis();
  });

  es.onerror = () => {
    // EventSource reintenta solo; no hacemos nada
  };
}

function setAgentState(id, patch) {
  agentState[id] = { ...(agentState[id] || {}), ...patch };
}

// Reconstruye el estado de las tarjetas a partir de los runs en memoria,
// para que recargar el panel no las deje en blanco
function rebuildAgentState() {
  [...runs].reverse().forEach((run) => {
    const st = agentState[run.agentId] || {};
    if (isActive(run)) {
      setAgentState(run.agentId, {
        status: run.status === "running" ? "working" : "queued",
        taskLabel: run.meta?.task_label || truncate(run.prompt, 60),
      });
    } else {
      setAgentState(run.agentId, {
        status: run.status === "error" ? "error" : "idle",
        taskLabel: run.meta?.task_label || truncate(run.prompt, 60),
        lastDuration: run.durationMs,
        count: (st.count || 0) + (run.status === "done" ? 1 : 0),
      });
    }
  });
}

// ================= Render: proyectos =================
function renderProjects() {
  const list = $("#projectList");
  list.innerHTML = "";

  if (projects.length === 0) {
    list.innerHTML = `
      <button class="project-pick" data-pick>
        <span class="plus">+</span>
        <span>Seleccione carpeta</span>
      </button>
      <div class="project-hint">Todavía sin carpetas. Al registrar un plan, Claude Code añade el proyecto aquí.</div>
    `;
    list.querySelector("[data-pick]").addEventListener("click", pickFolder);
    return;
  }

  const activeCwd = sessions.find((s) => s.id === activeSessionId)?.cwd;
  projects.forEach((p) => {
    const row = document.createElement("div");
    row.className = "project-row";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    if (!p.exists) row.classList.add("missing");
    if (p.path === activeCwd || (currentPlan && p.path === currentPlan.project)) row.classList.add("active");

    let progress = "";
    if (currentPlan && currentPlan.project === p.path) {
      const done = currentPlan.steps.filter((s) => s.status === "done").length;
      progress = `<span class="pprogress">${done}/${currentPlan.steps.length}</span>`;
    }
    const live = sessions.some((s) => s.cwd === p.path && !s.exited);

    row.innerHTML = `
      <div class="line">
        <span class="pdot ${live ? "live" : ""}" title="${live ? "Terminal abierta en esta carpeta" : ""}"></span>
        <span class="pname">${escapeHtml(p.name)}</span>
        ${p.exists ? "" : '<span class="badge-red">Suprimido</span>'}
        ${progress}
      </div>
      <span class="ppath">${escapeHtml(tildePath(p.path))}</span>
      ${p.branch ? `<span class="pbranch">⑂ ${escapeHtml(p.branch)}</span>` : ""}
      <button class="premove" title="Quitar de recientes">✕</button>
    `;

    row.addEventListener("click", (e) => {
      if (e.target.closest(".premove")) return;
      openProject(p);
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter") openProject(p);
    });
    row.querySelector(".premove").addEventListener("click", () => removeProject(p));
    list.appendChild(row);
  });
}

async function openProject(p) {
  if (!p.exists) {
    alert(`La carpeta ya no existe:\n${p.path}\n\nPuedes quitarla de recientes con ✕.`);
    return;
  }
  const size = terminalSize();
  try {
    const session = await api("/api/terminals", { path: p.path, ...size });
    upsertSession(session);
    attachSession(session.id);
    showTab("sesion");
  } catch (err) {
    alert(err.message);
  }
}

async function removeProject(p) {
  const live = sessions.some((s) => s.cwd === p.path && !s.exited);
  const msg = live
    ? `¿Quitar "${p.name}" de recientes? Su terminal abierta se cerrará.`
    : `¿Quitar "${p.name}" de recientes? La carpeta no se borra.`;
  if (!confirm(msg)) return;
  try {
    projects = await api("/api/projects", { path: p.path }, "DELETE");
    renderProjects();
  } catch (err) {
    alert(err.message);
  }
}

// Selector de carpeta: la app nativa abre el diálogo de Finder y responde
// llamando a window.onFolderPicked. Fuera de la app se pide la ruta a mano.
function pickFolder() {
  const bridge = window.webkit?.messageHandlers?.pickFolder;
  if (bridge) {
    bridge.postMessage(null);
    return;
  }
  const p = prompt("Ruta absoluta de la carpeta:");
  if (p) window.onFolderPicked(p);
}

window.onFolderPicked = async (folder) => {
  try {
    const project = await api("/api/projects", { path: folder });
    const idx = projects.findIndex((p) => p.path === project.path);
    if (idx >= 0) projects[idx] = project;
    else projects.unshift(project);
    renderProjects();
    openProject(project);
  } catch (err) {
    alert(err.message);
  }
};

$("#addProjectBtn").addEventListener("click", pickFolder);
$("#sessionPickBtn").addEventListener("click", pickFolder);

// ---- Dock de la terminal: plegar, estirar y saltar a tamaño completo ----
const DOCK_HEIGHT_KEY = "dispatch.dockHeight";
const DOCK_OPEN_KEY = "dispatch.dockOpen";

function setDockHeight(px) {
  const h = Math.max(120, Math.min(700, Math.round(px)));
  $("#dockBody").style.height = `${h}px`;
  localStorage.setItem(DOCK_HEIGHT_KEY, String(h));
  requestAnimationFrame(fitTerminal);
}

function setDockOpen(open) {
  $("#terminalDock").classList.toggle("collapsed", !open);
  $("#dockToggleBtn").textContent = open ? "▾" : "▸";
  $("#dockToggleBtn").title = open ? "Plegar" : "Desplegar";
  localStorage.setItem(DOCK_OPEN_KEY, open ? "1" : "0");
  if (open) requestAnimationFrame(fitTerminal);
}

setDockHeight(Number(localStorage.getItem(DOCK_HEIGHT_KEY)) || 300);
setDockOpen(localStorage.getItem(DOCK_OPEN_KEY) !== "0");

$("#dockToggleBtn").addEventListener("click", () =>
  setDockOpen($("#terminalDock").classList.contains("collapsed"))
);
$("#dockExpandBtn").addEventListener("click", () => showTab("sesion"));
$("#dockOpenBtn").addEventListener("click", pickFolder);

// Estirar el alto arrastrando la barra de abajo
$("#dockGrip").addEventListener("pointerdown", (e) => {
  const startY = e.clientY;
  const startH = $("#dockBody").offsetHeight;
  const move = (ev) => setDockHeight(startH + (ev.clientY - startY));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  e.preventDefault();
});

// ================= Sesión: terminal del proyecto =================
let term = null;
let fitAddon = null;
let termStream = null;
let termResizeObserver = null;
let resizeTimer = null;
let inputQueue = "";
let inputBusy = false;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function terminalSize() {
  return term ? { cols: term.cols, rows: term.rows } : { cols: 100, rows: 30 };
}

function upsertSession(session) {
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) sessions[idx] = session;
  else sessions.push(session);
}

function detachTerminal() {
  if (termStream) termStream.close();
  if (termResizeObserver) termResizeObserver.disconnect();
  if (term) term.dispose();
  term = fitAddon = termStream = termResizeObserver = null;
  inputQueue = "";
  activeSessionId = null;
  $("#terminalHost").innerHTML = "";
  renderSessionUI();
}

function attachSession(id) {
  if (activeSessionId === id && term) return;
  detachTerminal();
  activeSessionId = id;
  // Mostrar el contenedor antes de abrir xterm, o no puede medir el tamaño
  renderSessionUI();

  term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: {
      background: cssVar("--sunken"),
      foreground: cssVar("--text-2"),
      cursor: cssVar("--accent"),
      cursorAccent: cssVar("--sunken"),
      selectionBackground: cssVar("--accent-line"),
    },
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($("#terminalHost"));
  fitTerminal();

  termStream = new EventSource(`/api/terminals/${id}/stream`);
  termStream.addEventListener("buffer", (e) => {
    term.reset();
    term.write(JSON.parse(e.data));
  });
  termStream.addEventListener("data", (e) => term.write(JSON.parse(e.data)));
  termStream.addEventListener("exit", (e) => {
    const { exitCode } = JSON.parse(e.data);
    const s = sessions.find((x) => x.id === id);
    if (s) Object.assign(s, { exited: true, exitCode });
    renderSessionUI();
  });

  term.onData((data) => sendInput(id, data));
  term.onResize(({ cols, rows }) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      api(`/api/terminals/${id}/resize`, { cols, rows }).catch(() => {});
    }, 120);
  });

  termResizeObserver = new ResizeObserver(() => fitTerminal());
  termResizeObserver.observe($("#terminalHost"));

  // Ajustar el pty al tamaño real de la ventana
  api(`/api/terminals/${id}/resize`, terminalSize()).catch(() => {});
  renderSessionUI();
  renderProjects();
  term.focus();
}

function fitTerminal() {
  const host = $("#terminalHost");
  if (!term || !fitAddon || host.offsetWidth === 0) return;
  try {
    fitAddon.fit();
  } catch (_) {}
}

// Las teclas se mandan en orden: una petición a la vez, agrupando lo que se
// escriba mientras tanto
function sendInput(id, data) {
  inputQueue += data;
  if (!inputBusy) flushInput(id);
}

async function flushInput(id) {
  inputBusy = true;
  while (inputQueue && activeSessionId === id) {
    const chunk = inputQueue;
    inputQueue = "";
    try {
      await api(`/api/terminals/${id}/input`, { data: chunk });
    } catch (_) {
      inputQueue = "";
    }
  }
  inputBusy = false;
}

// El dock del carril derecho muestra de qué sesión es la terminal que se ve.
function renderDock() {
  const active = sessions.find((s) => s.id === activeSessionId);
  $("#dockEmpty").hidden = !!active;
  $("#terminalHost").hidden = !active;
  const state = $("#dockState");
  if (!active) state.textContent = "";
  else state.textContent = active.exited ? `${active.name} · terminada` : active.name;
  state.classList.toggle("off", !active || active.exited);
}

function renderSessionUI() {
  const live = sessions.filter((s) => !s.exited).length;
  $("#sessionCount").textContent = live ? String(live) : "";
  $("#infoSessions").textContent = String(live);
  renderDock();

  const active = sessions.find((s) => s.id === activeSessionId);
  $("#sessionEmpty").hidden = !!active;
  $("#sessionWrap").hidden = !active;
  if (!active) return;

  const tabs = $("#sessionTabs");
  tabs.innerHTML = "";
  if (sessions.length > 1) {
    sessions.forEach((s) => {
      const chip = document.createElement("button");
      chip.className = `session-chip ${s.id === activeSessionId ? "active" : ""}`;
      chip.innerHTML = `<span class="sdot ${s.exited ? "off" : ""}"></span>${escapeHtml(s.name)}`;
      chip.addEventListener("click", () => attachSession(s.id));
      tabs.appendChild(chip);
    });
  }

  const project = projects.find((p) => p.path === active.cwd);
  $("#sessionName").textContent = active.name;
  $("#sessionPath").textContent = [tildePath(active.cwd), project?.branch ? `⑂ ${project.branch}` : null]
    .filter(Boolean)
    .join(" · ");
  const state = $("#sessionState");
  state.textContent = active.exited ? `terminada (código ${active.exitCode ?? "?"})` : "● en curso";
  state.classList.toggle("off", active.exited);
}

$("#closeSessionBtn").addEventListener("click", async () => {
  const active = sessions.find((s) => s.id === activeSessionId);
  if (!active) return;
  if (!active.exited && !confirm(`¿Cerrar la terminal de "${active.name}"?`)) return;
  try {
    await api(`/api/terminals/${active.id}`, undefined, "DELETE");
  } catch (err) {
    alert(err.message);
  }
});

$("#restartSessionBtn").addEventListener("click", async () => {
  const active = sessions.find((s) => s.id === activeSessionId);
  if (!active) return;
  if (!active.exited && !confirm(`¿Reiniciar la sesión en "${active.name}"? Se cierra la actual.`)) return;
  try {
    const size = terminalSize();
    await api(`/api/terminals/${active.id}`, undefined, "DELETE");
    const session = await api("/api/terminals", { path: active.cwd, ...size });
    upsertSession(session);
    attachSession(session.id);
  } catch (err) {
    alert(err.message);
  }
});

// ================= Render: tarjetas de agentes =================
function renderAgents() {
  const grid = $("#agentGrid");
  grid.innerHTML = "";

  let working = 0;
  agents.forEach((a) => {
    const st = agentState[a.id] || {};
    if (st.status === "working") working++;

    // runs va del más nuevo al más viejo
    const liveRun = runs.find((r) => r.agentId === a.id && r.status === "running");
    const lastRun = liveRun || runs.find((r) => r.agentId === a.id);

    const card = document.createElement("div");
    card.className = "agent-card";
    if (lastRun) {
      card.classList.add("clickable");
      card.title = liveRun ? "Ver lo que está escribiendo" : "Ver su última tarea";
      card.addEventListener("click", () => openRunModal(lastRun.id));
    }
    if (a.enabled === false) card.classList.add("disabled");
    if (st.status === "working") card.classList.add("working");
    if (st.status === "error") card.classList.add("error-state");

    const stateLabel =
      a.enabled === false ? "off" : st.status === "working" ? "trabajando" : st.status === "error" ? "error" : "libre";

    const stats = [st.count ? `${st.count} tareas` : null, st.lastDuration ? `último ${formatSeconds(st.lastDuration)}` : null]
      .filter(Boolean)
      .join(" · ");

    card.innerHTML = `
      <div class="head">
        <span class="emoji">${a.emoji || "🤖"}</span>
        <span class="name">${escapeHtml(a.name)}</span>
        <span class="state">${stateLabel}</span>
      </div>
      ${st.status === "working" || st.status === "error" ? `<div class="task">${escapeHtml(st.taskLabel || "")}</div>` : ""}
      ${liveRun ? `<div class="peek" data-peek="${liveRun.id}">${escapeHtml(peekText(liveRun))}</div>` : ""}
      ${stats ?`<div class="stats">${stats}</div>` : ""}
    `;
    grid.appendChild(card);
  });

  $("#activeCount").textContent = working > 0 ? `${working} trabajando` : "todos libres";
}

// ================= Render: KPIs y gráfica de 24 h =================
function renderKpis() {
  const today = new Date().toDateString();
  const finished = runs.filter((r) => !isActive(r) && r.status !== "cancelled");
  const done = runs.filter((r) => r.status === "done");
  const errors = runs.filter((r) => r.status === "error");
  const running = runs.filter((r) => r.status === "running").length;
  const todayCount = runs.filter((r) => new Date(r.startedAt).toDateString() === today).length;
  const avgMs = done.length ? done.reduce((sum, r) => sum + (r.durationMs || 0), 0) / done.length : null;
  const tokens = done.reduce((sum, r) => sum + (r.tokensApprox || 0), 0);
  const liveSessions = sessions.filter((s) => !s.exited).length;

  const kpis = [
    { label: "TAREAS HOY", value: runs.length ? todayCount : null, sub: `${runs.length} en memoria` },
    { label: "TIEMPO MEDIO", value: avgMs !== null ? formatSeconds(avgMs) : null, sub: "por tarea" },
    {
      label: "TASA DE ERROR",
      value: finished.length ? `${((errors.length / finished.length) * 100).toFixed(1)}%` : null,
      sub: `${errors.length} de ${finished.length} runs`,
    },
    {
      label: "TOKENS CLAUDE",
      value: claudeUsage?.available ? formatTokens(claudeUsage.today.total) : null,
      sub: claudeUsage?.available
        ? `hoy · ${claudeUsage.today.messages} respuestas`
        : "sin transcripts",
      always: true,
    },
    { label: "TOKENS AGENTES", value: done.length ? `~${formatCount(tokens)}` : null, sub: "estimados" },
    {
      label: "EN CURSO",
      value: running,
      sub: laneSummary(),
      always: true,
    },
    { label: "SESIONES", value: liveSessions, sub: "terminales abiertas", always: true },
  ];

  $("#kpiGrid").innerHTML = kpis
    .map(
      (k) => `
      <div class="kpi">
        <div class="klabel">${k.label}</div>
        <div class="kvalue ${k.value === null ? "empty" : ""}">${k.value === null ? "—" : k.value}</div>
        <div class="ksub">${runs.length || k.always ? escapeHtml(k.sub) : "sin datos"}</div>
      </div>`
    )
    .join("");

  // Runs por hora en las últimas 24 h; la última barra es la hora actual
  const HOUR = 3600 * 1000;
  const now = Date.now();
  const buckets = new Array(24).fill(0);
  runs.forEach((r) => {
    const age = now - new Date(r.startedAt).getTime();
    if (age < 0 || age >= 24 * HOUR) return;
    buckets[23 - Math.floor(age / HOUR)]++;
  });
  const max = Math.max(...buckets, 1);
  const total = buckets.reduce((a, b) => a + b, 0);
  $("#sparkTotal").textContent = `${total} total`;
  $("#spark").innerHTML = buckets
    .map((n, i) => {
      const cls = i === 23 ? "now" : n === 0 ? "zero" : "";
      const label = i === 23 ? "última hora" : `hace ${23 - i} h`;
      return `<div class="bar ${cls}" style="height:${Math.max((n / max) * 100, 7)}%" title="${label}: ${n} runs"></div>`;
    })
    .join("");
}

// ================= Render: timeline =================
function renderTimeline() {
  const tl = $("#timeline");
  if (runs.length === 0) {
    tl.innerHTML = '<p class="empty-note">Sin actividad todavía. Las delegaciones de Claude Code aparecerán aquí en vivo.</p>';
    return;
  }

  tl.innerHTML = "";
  runs.slice(0, 40).forEach((run) => {
    const agent = agents.find((a) => a.id === run.agentId);
    const div = document.createElement("div");
    div.className = `run-item ${run.status}`;
    div.dataset.runId = run.id;

    div.innerHTML = `
      <div class="run-head">
        <span>${agent?.emoji || "🤖"}</span>
        <span class="run-agent">${escapeHtml(agent?.name || run.agentId)}</span>
        <span class="run-badge source">${escapeHtml(run.source)}</span>
        ${run.meta?.task_label ? `<span class="run-badge">${escapeHtml(run.meta.task_label)}</span>` : ""}
        <span class="run-time">${formatTime(run.startedAt)}${run.durationMs ? ` · ${formatSeconds(run.durationMs)}` : ""}</span>
      </div>
      <div class="run-prompt">Tarea: <span>${escapeHtml(truncate(run.prompt, 160))}</span></div>
      ${
        run.status === "queued"
          ? '<div class="run-stream waiting">En cola, esperando turno…</div>'
          : run.status === "error" || run.status === "cancelled"
          ? `<div class="run-stream error-text">${escapeHtml(run.error || "")}</div>`
          : run.status === "running"
          ? `<div class="run-stream tail" data-stream="${run.id}"></div>`
          : run.response
          ? `<div class="run-stream fading">${escapeHtml(truncate(run.response, 600))}</div>`
          : ""
      }
    `;

    div.addEventListener("click", () => openRunModal(run.id));
    tl.appendChild(div);
    const stream = div.querySelector("[data-stream]");
    if (stream) fillRunStream(stream, run);
  });
}

// Mientras escribe se muestra el final del texto (lo último que salió), no el principio
function fillRunStream(el, run) {
  el.classList.toggle("thinking", !run.response && !!run.reasoning);
  el.innerHTML = escapeHtml(tail(run.response || run.reasoning, 400)) + '<span class="cursor"></span>';
  el.scrollTop = el.scrollHeight;
}

function updateRunStream(run) {
  const el = document.querySelector(`[data-stream="${run.id}"]`);
  if (el) fillRunStream(el, run);
  else if (runs.indexOf(run) < 40) renderTimeline();
}

// ================= Tokens de Claude Code =================
// El KPI da el número de hoy; esta tarjeta dice de qué está hecho. La caché va
// aparte porque es la mayor parte del total y cuesta distinto que lo demás.
function renderClaudeUsage() {
  const card = $("#usageCard");
  if (!claudeUsage || !claudeUsage.available) {
    card.innerHTML = `
      <div class="row baseline between">
        <span class="field-label">TOKENS DE CLAUDE CODE</span>
      </div>
      <div class="usage-empty">Sin transcripts de Claude Code en esta máquina.</div>`;
    return;
  }

  const { today, window: win, sessions: ses, models, lastAt } = claudeUsage;
  const rows = [
    ["Entrada", today.input],
    ["Salida", today.output],
    ["Caché escrita", today.cacheCreate],
    ["Caché leída", today.cacheRead],
  ];
  const top = models[0];

  card.innerHTML = `
    <div class="row baseline between">
      <span class="field-label">TOKENS DE CLAUDE CODE</span>
      <span class="mono muted small">${lastAt ? formatTime(lastAt) : ""}</span>
    </div>
    <div class="usage-rows">
      ${rows
        .map(
          ([label, value]) => `
        <div class="usage-row"><span>${label}</span><span class="mono">${formatTokens(value)}</span></div>`
        )
        .join("")}
    </div>
    <div class="usage-foot">
      <span>${ses.active} ${ses.active === 1 ? "sesión activa" : "sesiones activas"} · ${ses.today} hoy</span>
      <span class="mono">${formatTokens(win.total)} en ${claudeUsage.days} d</span>
    </div>
    ${top ? `<div class="usage-foot"><span>${escapeHtml(shortModel(top.model))}</span><span class="mono">${formatTokens(top.total)}</span></div>` : ""}
  `;
}

async function loadClaudeUsage() {
  try {
    claudeUsage = await api("/api/claude-usage");
  } catch (_) {
    claudeUsage = null;
  }
  renderClaudeUsage();
  renderKpis();
}

// ================= Cola por modelo =================
const maxParallel = () => queueInfo.max_parallel || config.max_parallel || 1;

// "qwen/qwen3-4b-2507" → "qwen3-4b-2507": en el panel el editor ya no cabe
const shortModel = (id) => String(id || "").split("/").pop();

// Una cola por modelo: el KPI dice qué está corriendo en cada uno, porque dos
// runs de modelos distintos sí van a la vez y dos del mismo no
function laneSummary() {
  const lanes = (queueInfo.models || []).filter((m) => m.active || m.queued);
  if (!lanes.length) return `máx. ${maxParallel()} por modelo`;
  return lanes
    .map((m) => `${shortModel(m.model)} ${m.active}${m.queued ? ` +${m.queued} en cola` : ""}`)
    .join(" · ");
}

// Aborta el stream en el servidor; el run vuelve por SSE como "cancelled"
async function cancelRun(id) {
  try {
    await fetch(`/api/runs/${id}`, { method: "DELETE" });
  } catch (_) {}
}

function updateElapsed(el, run) {
  const ms = run.durationMs ?? Date.now() - new Date(run.startedAt).getTime();
  const tokens = Math.round(((run.response || "").length + (run.reasoning || "").length) / 4);
  el.textContent = `${formatSeconds(ms)}${tokens ? ` · ~${tokens} tokens` : ""}`;
}

// Si el usuario subió para leer algo, no lo arrastramos al final
function stickToBottom(el, update) {
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  update();
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// Lo último que escribió, en una línea, para las tarjetas del carril derecho
function peekText(run) {
  const text = (run.response || run.reasoning || "").replace(/\s+/g, " ").trim();
  return text.length > 60 ? "…" + text.slice(-60) : text;
}

// ================= Modal de detalle =================
// Si el run sigue en curso, el modal se actualiza en vivo (ver run:token)
let modalRunId = null;

function openRunModal(id) {
  const run = runs.find((r) => r.id === id);
  if (!run) return;
  modalRunId = id;
  const agent = agents.find((a) => a.id === run.agentId);

  const label = run.meta?.task_label ? ` · ${run.meta.task_label}` : "";
  $("#modalTitle").textContent = `${agent?.emoji || "🤖"} ${agent?.name || run.agentId}${label}`;

  const statusClass = run.status === "done" ? "status-ok" : run.status === "error" ? "status-bad" : "";
  const statusText = run.status === "done" ? "ok" : run.status === "error" ? "error" : "en curso";
  $("#modalBody").innerHTML = `
    <div class="modal-meta">
      <span>${formatTime(run.startedAt)}</span>
      ${run.durationMs ? `<span>${formatSeconds(run.durationMs, 2)}</span>` : ""}
      ${run.tokensApprox ? `<span>~${run.tokensApprox} tokens</span>` : ""}
      <span>origen: ${escapeHtml(run.source)}</span>
      <span class="${statusClass}">${statusText}</span>
      ${isActive(run) ? '<button class="link-btn modal-cancel" id="modalCancelBtn">Cancelar</button>' : ""}
    </div>
    <div>
      <div class="field-label">TAREA ENVIADA</div>
      <pre class="modal-box">${escapeHtml(run.prompt)}</pre>
    </div>
    ${
      run.reasoning
        ? `<div>
      <div class="field-label">RAZONAMIENTO</div>
      <pre class="modal-box reasoning-box" id="modalReasoning">${escapeHtml(run.reasoning)}</pre>
    </div>`
        : ""
    }
    <div>
      <div class="field-label">${run.status === "error" ? "ERROR" : run.status === "running" ? "RESPUESTA · EN VIVO" : "RESPUESTA"}</div>
      <pre class="modal-box ${run.status === "error" ? "error-text" : ""}" id="modalResponse">${escapeHtml(run.error || run.response || "—")}</pre>
    </div>
  `;
  const cancelBtn = $("#modalCancelBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", () => cancelRun(run.id));
  if (run.status === "running") {
    $$("#modalBody .modal-box[id]").forEach((el) => (el.scrollTop = el.scrollHeight));
  }
  $("#modalBackdrop").classList.add("open");
}

function updateModalStream(run) {
  const response = $("#modalResponse");
  const reasoning = $("#modalReasoning");
  // El bloque de razonamiento aparece a mitad del stream: hay que volver a pintar
  if (!response || (run.reasoning && !reasoning)) return openRunModal(run.id);
  if (reasoning) stickToBottom(reasoning, () => (reasoning.textContent = run.reasoning));
  stickToBottom(response, () => (response.textContent = run.response || "—"));
}

function closeRunModal() {
  modalRunId = null;
  $("#modalBackdrop").classList.remove("open");
}

$("#closeModalBtn").addEventListener("click", closeRunModal);
$("#modalBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "modalBackdrop") closeRunModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeRunModal();
});

// ================= Editor de agentes =================
function agentStatsText(agentId) {
  const own = runs.filter((r) => r.agentId === agentId);
  const done = own.filter((r) => r.status === "done");
  const errors = own.filter((r) => r.status === "error");
  const finished = done.length + errors.length;
  if (!finished) return "sin tareas en esta sesión";
  const avg = done.length ? done.reduce((s, r) => s + (r.durationMs || 0), 0) / done.length : 0;
  return `${done.length} tareas · ${formatSeconds(avg)} de media · ${((errors.length / finished) * 100).toFixed(1)} % de error`;
}

function renderAgentsEditor() {
  const c = $("#agentsEditor");
  c.innerHTML = "";
  if (expandedAgents.size === 0 && agents[0]) expandedAgents.add(agents[0].id);

  agents.forEach((a) => {
    const block = document.createElement("div");
    block.className = `agent-block ${expandedAgents.has(a.id) ? "open" : ""}`;
    block.innerHTML = `
      <div class="block-head">
        <span class="bemoji">${a.emoji || "🤖"}</span>
        <input class="name-input" data-id="${a.id}" data-field="name" value="${escapeAttr(a.name)}" size="${Math.max(a.name.length + 2, 6)}" />
        <span class="id-tag">/agent/${a.id}</span>
        <span class="when-preview">${escapeHtml(a.use_when || "")}</span>
        <div class="block-right">
          <label class="toggle">
            <input type="checkbox" data-id="${a.id}" data-field="enabled" ${a.enabled !== false ? "checked" : ""} />
            <span class="track"></span>
            <span class="tlabel">ACTIVO</span>
          </label>
          <button class="btn danger" data-delete="${a.id}">Eliminar</button>
          <span class="chev">⌄</span>
        </div>
      </div>

      <div class="block-body">
        <div class="two-cols">
          <div>
            <label class="field-label">CUÁNDO USARLO · LO LEE CLAUDE CODE</label>
            <textarea data-id="${a.id}" data-field="use_when">${escapeHtml(a.use_when || "")}</textarea>
          </div>
          <div>
            <label class="field-label">SYSTEM PROMPT</label>
            <textarea data-id="${a.id}" data-field="system_prompt">${escapeHtml(a.system_prompt || "")}</textarea>
          </div>
        </div>
        <div class="mini-row">
          <div>
            <label class="field-label">TEMPERATURA</label>
            <input type="number" class="mono" step="0.1" min="0" max="1" data-id="${a.id}" data-field="temperature" value="${a.temperature ?? 0.3}" />
          </div>
          <div>
            <label class="field-label">MAX TOKENS</label>
            <input type="number" class="mono" step="50" min="100" data-id="${a.id}" data-field="max_tokens" value="${a.max_tokens ?? 1200}" />
          </div>
          <div>
            <label class="field-label">MODELO</label>
            <select class="mono" data-id="${a.id}" data-field="model">${modelOptions(a.model)}</select>
          </div>
          <div class="emoji-field">
            <label class="field-label">EMOJI</label>
            <input type="text" maxlength="2" data-id="${a.id}" data-field="emoji" value="${escapeAttr(a.emoji || "🤖")}" />
          </div>
          <span class="agent-stats">${agentStatsText(a.id)}</span>
        </div>
      </div>
    `;

    // Plegar / desplegar sin re-renderizar, para no perder lo que se esté editando
    block.querySelector(".block-head").addEventListener("click", (e) => {
      if (e.target.closest("input, button, label")) return;
      block.classList.toggle("open");
      if (block.classList.contains("open")) expandedAgents.add(a.id);
      else expandedAgents.delete(a.id);
    });
    c.appendChild(block);
  });

  $$("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(`¿Eliminar el agente "${btn.dataset.delete}"?`)) return;
      await fetch(`/api/agents/${btn.dataset.delete}`, { method: "DELETE" });
      await loadAgents();
    });
  });
}

$("#saveAgentsBtn").addEventListener("click", async () => {
  const updated = JSON.parse(JSON.stringify(agents));
  $$("#agentsEditor [data-id]").forEach((el) => {
    const agent = updated.find((a) => a.id === el.dataset.id);
    if (!agent) return;
    const f = el.dataset.field;
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (f === "temperature") v = parseFloat(v);
    if (f === "max_tokens") v = parseInt(v, 10);
    agent[f] = v;
  });

  try {
    await api("/api/agents", updated);
  } catch (err) {
    alert(`No se guardaron los cambios: ${err.message}`);
    return;
  }
  await loadAgents();
  // Las sesiones abiertas recibieron la lista al arrancar; el manifest les da la nueva
  const live = sessions.some((s) => !s.exited);
  flash("#agentsSaved", live ? "Guardado ✓ · Claude lo verá en su próxima tarea" : "Guardado ✓");
});

$("#addAgentBtn").addEventListener("click", async () => {
  const id = prompt("Id del nuevo agente (sin espacios, ej: 'refactor'):");
  if (!id) return;
  const name = prompt("Nombre visible:", id) || id;
  const use_when = prompt("¿Cuándo debe usarse este agente?", "") || "";
  const res = await fetch("/api/agents/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name, use_when }),
  });
  if (!res.ok) {
    const e = await res.json();
    alert(e.error);
    return;
  }
  await loadAgents();
});

// ================= Consola =================
function renderConsoleAgents() {
  const enabled = agents.filter((a) => a.enabled !== false);
  if (!enabled.some((a) => a.id === consoleAgentId)) consoleAgentId = enabled[0]?.id || null;

  const picker = $("#consoleAgents");
  picker.innerHTML = "";
  agents.forEach((a) => {
    const chip = document.createElement("button");
    chip.className = `chip ${a.id === consoleAgentId ? "active" : ""}`;
    chip.textContent = `${a.emoji || "🤖"} ${a.name}`;
    chip.disabled = a.enabled === false;
    chip.title = a.enabled === false ? "Desactivado" : a.use_when || "";
    chip.addEventListener("click", () => {
      consoleAgentId = a.id;
      renderConsoleAgents();
    });
    picker.appendChild(chip);
  });

  const agent = agents.find((a) => a.id === consoleAgentId);
  $("#consoleHint").textContent = agent
    ? `temp ${agent.temperature ?? 0.3} · máx. ${agent.max_tokens ?? 1200} tokens · ⌘↵ para enviar`
    : "No hay agentes activos";
}

async function sendConsole() {
  const agentId = consoleAgentId;
  const prompt = $("#consolePrompt").value.trim();
  if (!prompt || !agentId) return;

  const btn = $("#sendConsoleBtn");
  const status = $("#consoleStatus");
  btn.disabled = true;
  status.className = "muted";
  status.textContent = "Ejecutando…";
  $("#consoleOutput").textContent = "—";

  try {
    const res = await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    $("#consoleOutput").textContent = data.content;
    status.className = "status-ok";
    status.textContent = `completado en ${formatSeconds(data.durationMs)} · ~${Math.round(data.content.length / 4)} tokens`;
  } catch (err) {
    $("#consoleOutput").textContent = "Error: " + err.message;
    status.className = "status-bad";
    status.textContent = "falló";
  } finally {
    btn.disabled = false;
  }
}

$("#sendConsoleBtn").addEventListener("click", sendConsole);
$("#consolePrompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendConsole();
  }
});
$("#copyConsoleBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("#consoleOutput").textContent);
  flash("#consoleStatus", "Copiado ✓");
});

// ================= Estado / Config =================
async function refreshStatus() {
  const pill = $("#statusPill");
  const reach = $("#cfgReach");
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    lastStatus = data;
    config = { ...config, ...data.config };
    if (data.reachable) {
      if (data.queue) queueInfo = data.queue;
      pill.className = data.warning ? "status-pill warn" : "status-pill ok";
      $("#statusDot").className = data.warning ? "dot warn" : "dot ok";
      $("#statusText").textContent = data.warning || `${data.config.model} · en línea`;
      reach.className = data.warning ? "reach warn" : "reach ok";
      reach.textContent = data.warning ? "⚠ sin modelo" : "✓ responde";
      $("#infoModels").textContent = data.models?.length ? data.models.join(", ") : "ninguno cargado";
      refreshModelSelects();
    } else {
      pill.className = "status-pill bad";
      $("#statusDot").className = "dot bad";
      $("#statusText").textContent = "LM Studio sin conexión · reintentar";
      reach.className = "reach bad";
      reach.textContent = "✗ no responde";
      $("#infoModels").textContent = "—";
    }
  } catch {
    pill.className = "status-pill bad";
    $("#statusDot").className = "dot bad";
    $("#statusText").textContent = "orquestador sin conexión";
    reach.className = "reach bad";
    reach.textContent = "✗ sin orquestador";
  }
}

$("#statusPill").addEventListener("click", refreshStatus);

function renderParallel() {
  const seg = $("#cfgParallel");
  seg.innerHTML = "";
  PARALLEL_OPTIONS.forEach((n) => {
    const b = document.createElement("button");
    b.textContent = String(n);
    b.className = n === selectedParallel ? "active" : "";
    b.addEventListener("click", () => {
      selectedParallel = n;
      renderParallel();
    });
    seg.appendChild(b);
  });
}

async function loadConfig() {
  const res = await fetch("/api/config");
  config = await res.json();
  $("#cfgLmUrl").value = config.lmstudio_url;
  $("#cfgModel").value = config.model;
  selectedParallel = config.max_parallel || 1;
  $("#infoPort").textContent = `:${config.app_port || 3131}`;
  renderParallel();
  renderInstructions();
}

$("#saveConfigBtn").addEventListener("click", async () => {
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lmstudio_url: $("#cfgLmUrl").value.trim(),
      model: $("#cfgModel").value.trim(),
      max_parallel: selectedParallel,
    }),
  });
  await loadConfig();
  flash("#configSaved", "Guardado ✓");
  refreshStatus();
  renderKpis();
});

// ================= Instrucciones para Claude Code =================
// El texto lo genera el servidor: es el mismo que reciben las sesiones de terminal
// El editor se dibuja antes de la primera consulta de estado, así que los
// desplegables nacen vacíos: al llegar la lista los rellenamos sin re-renderizar
// el editor entero, para no pisar lo que se esté escribiendo en otro campo.
let modelSelectsKey = null;
function refreshModelSelects() {
  const key = (lastStatus?.models || []).join(",");
  if (key === modelSelectsKey) return;
  modelSelectsKey = key;
  $$('#agentsEditor select[data-field="model"]').forEach((sel) => {
    sel.innerHTML = modelOptions(sel.value || "");
  });
}

// Vacío = el modelo de config.json. Mantiene el que ya tenga el agente aunque
// LM Studio no lo reporte cargado ahora mismo, para no perderlo al guardar.
function modelOptions(current) {
  const loaded = lastStatus?.models || [];
  const all = [...new Set([...loaded, current].filter(Boolean))];
  const opts = [`<option value=""${current ? "" : " selected"}>por defecto (${escapeHtml(config.model || "—")})</option>`];
  all.forEach((m) => {
    const falta = !loaded.includes(m) ? " · sin cargar" : "";
    opts.push(`<option value="${escapeAttr(m)}"${m === current ? " selected" : ""}>${escapeHtml(m)}${falta}</option>`);
  });
  return opts.join("");
}

async function renderInstructions() {
  try {
    const { text } = await api("/api/instructions");
    $("#claudeInstructions").textContent = text;
  } catch (err) {
    $("#claudeInstructions").textContent = `No se pudieron cargar las instrucciones: ${err.message}`;
  }
}

$("#copyInstructionsBtn").addEventListener("click", () => {
  navigator.clipboard.writeText($("#claudeInstructions").textContent);
  flash("#copiedMsg", "Copiado ✓");
});

// ================= Limpiar =================
$("#clearRunsBtn").addEventListener("click", async () => {
  await fetch("/api/runs", { method: "DELETE" });
  runs = [];
  renderTimeline();
  renderKpis();
});

$("#clearPlanBtn").addEventListener("click", async () => {
  await fetch("/api/plan", { method: "DELETE" });
  currentPlan = null;
  renderPlan();
});

// ================= Utilidades =================
function truncate(s, n) {
  s = s || "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function tail(s, n) {
  s = s || "";
  return s.length > n ? "…" + s.slice(-n) : s;
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}
function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function flash(sel, msg) {
  const el = $(sel);
  const prev = el.textContent;
  el.textContent = msg;
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = sel === "#consoleStatus" ? prev : "";
  }, 2000);
}
function formatSeconds(ms, digits = 1) {
  return `${(ms / 1000).toFixed(digits)}s`;
}
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
// Los tokens de Claude llegan a decenas de millones en un día: en "k" no se leen
function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return String(v);
}

function formatCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}
// macOS: /Users/<usuario>/... → ~/...
function tildePath(p) {
  return (p || "").replace(/^\/Users\/[^/]+/, "~");
}

// ================= Init =================
async function loadAgents() {
  agents = await (await fetch("/api/agents")).json();
  renderAgents();
  renderAgentsEditor();
  renderConsoleAgents();
  renderInstructions();
}

async function init() {
  await loadAgents();
  await loadConfig();
  runs = await (await fetch("/api/runs")).json();
  currentPlan = await (await fetch("/api/plan")).json();
  projects = await (await fetch("/api/projects")).json();
  sessions = await (await fetch("/api/terminals")).json();
  await loadClaudeUsage();

  rebuildAgentState();
  renderAgents();
  renderAgentsEditor();
  renderPlan();
  renderTimeline();
  renderKpis();
  renderSessionUI();

  // Si quedó una sesión abierta (p. ej. tras recargar), volver a conectarla
  const live = sessions.find((s) => !s.exited);
  if (live) attachSession(live.id);

  await refreshStatus();
  connectStream();
  setInterval(refreshStatus, 6000);
  // La gráfica de 24 h depende de la hora, no solo de los eventos
  setInterval(renderKpis, 60000);
  // Cronómetro de los runs en curso (tarjetas de agentes y modal)
  setInterval(() => {
    runs
      .filter((r) => r.status === "running")
      .forEach((run) => {
        const el = document.querySelector(`[data-elapsed="${run.id}"]`);
        if (el) updateElapsed(el, run);
      });
  }, 500);
}

init();
