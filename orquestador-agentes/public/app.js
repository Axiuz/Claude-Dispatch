const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let agents = [];
let runs = [];
let config = {};
let currentPlan = null;
let projects = [];
let sessions = []; // sesiones de terminal: {id, cwd, kind, name, startedAt, exited, exitCode}
let lastStatus = null;
// Tokens que lleva gastados Claude Code, leídos de sus transcripts por el servidor
let claudeUsage = null;
const agentState = {}; // id -> {status, taskLabel, lastDuration, count}

// Dos terminales distintas: la de Claude Code (pestaña Sesión) y la shell del
// dock. Cada una con su sesión en el servidor y su instancia de xterm; cuál ve
// cada una lo guarda la vista (sessionTerm.sessionId, dockTerm.sessionId).
let dockCwd = null; // carpeta a la que apunta el dock; sigue a la sesión activa
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
  // Cada terminal mide su tamaño al hacerse visible: xterm no puede medir un
  // contenedor oculto, y el dock desaparece en las pestañas anchas
  requestAnimationFrame(() => {
    if (tab === "sesion") sessionTerm.fit();
    dockTerm.fit();
  });
  // El canvas del mapa y Monaco solo se pueden medir cuando son visibles
  if (tab === "mapa") requestAnimationFrame(() => CodeMap.open());
  if (tab === "editor") requestAnimationFrame(() => CodeEditor.open());
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
  });

  es.addEventListener("queue:updated", (e) => {
    queueInfo = JSON.parse(e.data);
  });

  es.addEventListener("runs:cleared", () => {
    runs = [];
    renderTimeline();
  });

  es.addEventListener("projects:updated", (e) => {
    projects = JSON.parse(e.data);
    renderProjects();
    if (!gitInfo) loadGit();
    if (currentPlan) renderPlan();
    renderSessionUI();
  });

  // Una escritura de git desde el panel (aquí o en otra ventana): se relee, pero
  // sin forzar, para no pisar un menú abierto ni la caja de mensaje
  es.addEventListener("git:changed", (e) => {
    const { path } = JSON.parse(e.data);
    if (path === gitDir()) loadGit({ refresh: true });
  });

  // Claude Code puede dejar el plan de commits puesto: si es el del repo que
  // tenemos delante, se trae solo
  es.addEventListener("git:plan", (e) => {
    const { root } = JSON.parse(e.data);
    if (gitInfo && gitInfo.root === root) loadGitPlan();
  });

  es.addEventListener("terminals:updated", (e) => {
    sessions = JSON.parse(e.data);
    // Si una de las dos terminales visibles desapareció, pasar a otra del mismo
    // tipo o quedarse vacía; nunca mostrar la de Claude Code en el dock
    if (sessionTerm.sessionId && !sessions.some((s) => s.id === sessionTerm.sessionId)) {
      const next = claudeSessions().find((s) => !s.exited) || claudeSessions()[0];
      if (next) attachClaudeSession(next.id);
      else sessionTerm.detach();
    }
    if (dockTerm.sessionId && !sessions.some((s) => s.id === dockTerm.sessionId)) dockTerm.detach();
    renderSessionUI();
    renderProjects();
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

  const activeCwd = activeSession()?.cwd;
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
  // Abrir un proyecto arranca Claude Code. La shell del dock no se crea aquí:
  // solo apunta a esta carpeta y espera a que la pidan.
  try {
    const session = await api("/api/terminals", { path: p.path, kind: "claude", ...sessionTerm.size() });
    upsertSession(session);
    attachClaudeSession(session.id);
    showTab("sesion");
  } catch (err) {
    alert(err.message);
  }
}

async function removeProject(p) {
  const live = sessions.some((s) => s.cwd === p.path && !s.exited);
  const msg = live
    ? `¿Quitar "${p.name}" de recientes? Sus terminales abiertas se cerrarán.`
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

// ---- Dock de la terminal: plegar y estirar ----
// Sin botones en la cabecera: la cabecera entera es el interruptor de plegado y
// el alto se arrastra desde la barra de abajo.
const DOCK_HEIGHT_KEY = "dispatch.dockHeight";
const DOCK_OPEN_KEY = "dispatch.dockOpen";

function setDockHeight(px) {
  const h = Math.max(120, Math.min(700, Math.round(px)));
  $("#dockBody").style.height = `${h}px`;
  localStorage.setItem(DOCK_HEIGHT_KEY, String(h));
  requestAnimationFrame(() => dockTerm.fit());
}

function setDockOpen(open) {
  $("#terminalDock").classList.toggle("collapsed", !open);
  $("#dockHead").setAttribute("aria-expanded", open ? "true" : "false");
  $("#dockHead").title = open ? "Plegar" : "Desplegar";
  localStorage.setItem(DOCK_OPEN_KEY, open ? "1" : "0");
  if (open) requestAnimationFrame(() => dockTerm.fit());
}

const toggleDock = () => setDockOpen($("#terminalDock").classList.contains("collapsed"));

setDockHeight(Number(localStorage.getItem(DOCK_HEIGHT_KEY)) || 300);
setDockOpen(localStorage.getItem(DOCK_OPEN_KEY) !== "0");

$("#dockHead").addEventListener("click", toggleDock);
$("#dockHead").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleDock();
  }
});
$("#dockOpenBtn").addEventListener("click", (e) => {
  e.stopPropagation(); // el botón vive dentro del dock, no debe plegarlo
  if (dockCwd) openDockShell();
  else pickFolder();
});

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

// ---- Anchos arrastrables: carriles y árbol del Editor ----
// Los tres van a variables CSS y se guardan en localStorage. Los topes evitan
// que el centro se quede sin sitio para el tablero de cinco columnas.
const WIDTH_KEYS = {
  "--rail-left": "dispatch.railLeft",
  "--rail-right": "dispatch.railRight",
  "--ed-tree": "dispatch.edTree",
};

function setWidth(varName, px, min, max) {
  const w = Math.max(min, Math.min(max, Math.round(px)));
  document.documentElement.style.setProperty(varName, `${w}px`);
  localStorage.setItem(WIDTH_KEYS[varName], String(w));
  return w;
}

// dir = 1 cuando el tirador está a la izquierda del borde que mueve (carril
// izquierdo, árbol); -1 cuando está a la derecha (carril derecho)
function makeWidthDrag(handleSelector, varName, { min, max, dir, onMove }) {
  const handle = $(handleSelector);
  if (!handle) return;
  const stored = Number(localStorage.getItem(WIDTH_KEYS[varName]));
  if (stored) setWidth(varName, stored, min, max);

  handle.addEventListener("pointerdown", (e) => {
    const startX = e.clientX;
    const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(varName), 10);
    document.body.classList.add("resizing-x");
    const move = (ev) => {
      setWidth(varName, startW + (ev.clientX - startX) * dir, min, max);
      if (onMove) onMove();
    };
    const up = () => {
      document.body.classList.remove("resizing-x");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  });
  handle.addEventListener("dblclick", () => {
    localStorage.removeItem(WIDTH_KEYS[varName]);
    document.documentElement.style.removeProperty(varName);
    if (onMove) onMove();
  });
}

makeWidthDrag("#railLeftResizer", "--rail-left", { min: 190, max: 460, dir: 1 });
makeWidthDrag("#railRightResizer", "--rail-right", {
  min: 260,
  max: 640,
  dir: -1,
  onMove: () => dockTerm.fit(),
});
makeWidthDrag("#edResizer", "--ed-tree", { min: 150, max: 520, dir: 1 });

// ================= Terminales: Claude Code y shell =================
// Dos instancias de xterm, no una que se muda de sitio: la pestaña Sesión
// muestra la sesión de Claude Code de la carpeta y el dock del carril derecho
// una shell pelada para comandos sueltos. Cada vista tiene su EventSource y su
// cola de teclas, así que las dos pueden estar vivas a la vez.

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const sessionById = (id) => sessions.find((s) => s.id === id);
const claudeSessions = () => sessions.filter((s) => s.kind === "claude");
const activeSession = () => sessionById(sessionTerm.sessionId);

function upsertSession(session) {
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) sessions[idx] = session;
  else sessions.push(session);
}

// Una vista = un xterm atado a un nodo del DOM y, como mucho, a una sesión
function createTerminalView(hostSelector) {
  let term = null;
  let fitAddon = null;
  let stream = null;
  let observer = null;
  let resizeTimer = null;
  let queue = "";
  let busy = false;

  const host = () => $(hostSelector);

  // Las teclas se mandan en orden: una petición a la vez, agrupando lo que se
  // escriba mientras tanto
  async function flush(id) {
    busy = true;
    while (queue && view.sessionId === id) {
      const chunk = queue;
      queue = "";
      try {
        await api(`/api/terminals/${id}/input`, { data: chunk });
      } catch (_) {
        queue = "";
      }
    }
    busy = false;
  }

  const view = {
    sessionId: null,

    size: () => (term ? { cols: term.cols, rows: term.rows } : { cols: 100, rows: 30 }),

    focus() {
      if (term) term.focus();
    },

    fit() {
      const el = host();
      if (!term || !fitAddon || !el || el.offsetWidth === 0) return;
      try {
        fitAddon.fit();
      } catch (_) {}
    },

    detach() {
      if (stream) stream.close();
      if (observer) observer.disconnect();
      if (term) term.dispose();
      term = fitAddon = stream = observer = null;
      queue = "";
      view.sessionId = null;
      host().innerHTML = "";
      renderSessionUI();
    },

    attach(id) {
      if (view.sessionId === id && term) return;
      view.detach();
      view.sessionId = id;
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
      term.open(host());
      view.fit();

      stream = new EventSource(`/api/terminals/${id}/stream`);
      stream.addEventListener("buffer", (e) => {
        term.reset();
        term.write(JSON.parse(e.data));
      });
      stream.addEventListener("data", (e) => term.write(JSON.parse(e.data)));
      stream.addEventListener("exit", (e) => {
        const { exitCode } = JSON.parse(e.data);
        const s = sessionById(id);
        if (s) Object.assign(s, { exited: true, exitCode });
        renderSessionUI();
      });

      term.onData((data) => {
        queue += data;
        if (!busy) flush(id);
      });
      term.onResize(({ cols, rows }) => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          api(`/api/terminals/${id}/resize`, { cols, rows }).catch(() => {});
        }, 120);
      });

      observer = new ResizeObserver(() => view.fit());
      observer.observe(host());

      // Ajustar el pty al tamaño real de la ventana
      api(`/api/terminals/${id}/resize`, view.size()).catch(() => {});
      renderSessionUI();
      renderProjects();
      term.focus();
    },
  };

  return view;
}

const sessionTerm = createTerminalView("#sessionTerminalHost");
const dockTerm = createTerminalView("#dockTerminalHost");

// ---- Sesión de Claude Code ----
function attachClaudeSession(id) {
  sessionTerm.attach(id);
  const s = sessionById(id);
  if (s) followDock(s.cwd);
}

// ---- Shell del dock ----
// El dock sigue a la carpeta de la sesión activa. Si esa carpeta ya tiene una
// shell viva se engancha a ella; si no, se queda vacío con el botón de abrirla:
// el pty solo se crea cuando hace falta, no al abrir el proyecto.
function followDock(cwd) {
  const changed = dockCwd !== cwd;
  dockCwd = cwd;
  if (changed) {
    gitInfo = null;
    loadGit({ refresh: true });
  }
  const shell = sessions.find((s) => s.kind === "shell" && s.cwd === cwd && !s.exited);
  if (shell) dockTerm.attach(shell.id);
  else if (dockTerm.sessionId) dockTerm.detach();
  else renderSessionUI();
}

async function openDockShell() {
  if (!dockCwd) return pickFolder();
  try {
    const session = await api("/api/terminals", { path: dockCwd, kind: "shell", ...dockTerm.size() });
    upsertSession(session);
    dockTerm.attach(session.id);
    dockTerm.focus();
  } catch (err) {
    alert(err.message);
  }
}

// El dock del carril derecho muestra su propia shell, no la de Claude Code
function renderDock() {
  const active = sessionById(dockTerm.sessionId);
  const project = dockCwd ? projects.find((p) => p.path === dockCwd) : null;
  $("#dockEmpty").hidden = !!active;
  $("#dockTerminalHost").hidden = !active;
  $("#dockEmptyText").textContent = dockCwd
    ? `Sin shell en ${project?.name || tildePath(dockCwd)}.`
    : "Sin carpeta abierta.";
  $("#dockOpenBtn").textContent = dockCwd ? "Abrir shell" : "Abrir un proyecto";
  const state = $("#dockState");
  if (!active) state.textContent = "";
  else state.textContent = active.exited ? `${active.name} · terminada` : active.name;
  state.classList.toggle("off", !active || active.exited);
}

function renderSessionUI() {
  const live = sessions.filter((s) => !s.exited);
  $("#sessionCount").textContent = live.some((s) => s.kind === "claude")
    ? String(live.filter((s) => s.kind === "claude").length)
    : "";
  $("#infoSessions").textContent = String(live.length);
  renderDock();

  const active = activeSession();
  $("#sessionEmpty").hidden = !!active;
  $("#sessionWrap").hidden = !active;
  if (!active) return;

  const chips = claudeSessions();
  const tabs = $("#sessionTabs");
  tabs.innerHTML = "";
  if (chips.length > 1) {
    chips.forEach((s) => {
      const chip = document.createElement("button");
      chip.className = `session-chip ${s.id === active.id ? "active" : ""}`;
      chip.innerHTML = `<span class="sdot ${s.exited ? "off" : ""}"></span>${escapeHtml(s.name)}`;
      chip.addEventListener("click", () => attachClaudeSession(s.id));
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
  const active = activeSession();
  if (!active) return;
  if (!active.exited && !confirm(`¿Cerrar la sesión de Claude Code en "${active.name}"?`)) return;
  try {
    await api(`/api/terminals/${active.id}`, undefined, "DELETE");
  } catch (err) {
    alert(err.message);
  }
});

$("#restartSessionBtn").addEventListener("click", async () => {
  const active = activeSession();
  if (!active) return;
  if (!active.exited && !confirm(`¿Reiniciar Claude Code en "${active.name}"? Se cierra la sesión actual.`)) return;
  try {
    const size = sessionTerm.size();
    await api(`/api/terminals/${active.id}`, undefined, "DELETE");
    const session = await api("/api/terminals", { path: active.cwd, kind: "claude", ...size });
    upsertSession(session);
    attachClaudeSession(session.id);
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
}

// ================= Git: control de código de la carpeta activa =================
// Lo que enseña VS Code en su barra lateral, reducido a lo que cabe en el carril:
// en qué rama estás, qué archivos tienes tocados y los últimos commits, y desde
// aquí mismo cambiar de rama, preparar archivos y commitear (con amend, push y
// sync). Lo que no está —diffs, rebase, resolver conflictos— sigue siendo cosa
// de la terminal.
const GIT_POLL_MS = 5000;
const MAX_GIT_FILES = 12;
const MAX_GIT_COMMITS = 10;
const BRANCH_FILTER_FROM = 8;   // a partir de cuántas ramas sale el buscador

let gitInfo = null;      // última respuesta de /api/git
let gitLoading = false;
let gitBusy = false;     // hay una operación de escritura en curso
let gitDraft = "";       // el mensaje de commit que se está escribiendo
let gitDraftRoot = null; // de qué repositorio es ese borrador
let gitMenu = null;      // menú flotante abierto, si hay alguno
let gitPlan = null;      // plan de commits del repositorio de delante
let gitPasting = false;  // está abierta la caja de pegar el plan
let gitPasteDraft = "";  // lo que lleva escrito esa caja

// La carpeta del dock manda; si todavía no hay ninguna sesión abierta se enseña
// el último proyecto, que es lo que el usuario tiene delante en el carril izquierdo
const gitDir = () => dockCwd || projects.find((p) => p.exists)?.path || null;

// El borrador se guarda por repositorio, como en VS Code: irse a otra carpeta y
// volver no debe perder lo que llevabas escrito.
const draftKey = (root) => `orq.commitMsg.${root}`;

function readDraft(root) {
  try {
    return localStorage.getItem(draftKey(root)) || "";
  } catch (_) {
    return "";
  }
}

function setDraft(text, { render = true } = {}) {
  gitDraft = text;
  try {
    if (gitDraftRoot) {
      if (text) localStorage.setItem(draftKey(gitDraftRoot), text);
      else localStorage.removeItem(draftKey(gitDraftRoot));
    }
  } catch (_) {}
  if (render) renderGit();
}

async function loadGit({ refresh = false, force = false } = {}) {
  const dir = gitDir();
  if (!dir) {
    gitInfo = null;
    return renderGit();
  }
  if (gitLoading) return;
  // Con un menú abierto o una operación en marcha el sondeo no repinta: se
  // llevaría por delante el menú y el foco de la caja de mensaje
  if (!force && (gitBusy || gitMenu || gitPasting)) return;
  gitLoading = true;
  try {
    const q = `path=${encodeURIComponent(dir)}${refresh ? "&refresh=1" : ""}`;
    const data = await api(`/api/git?${q}`);
    // La carpeta pudo cambiar mientras respondía: se descarta lo que ya no toca
    if (data.path === gitDir()) gitInfo = data;
  } catch (_) {
    gitInfo = null;
  } finally {
    gitLoading = false;
  }
  renderGit();
  // El plan solo se repide al cambiar de repositorio: lo demás llega por SSE,
  // así el sondeo de 5 s no se convierte en dos peticiones
  if (gitInfo && gitPlan?.root !== gitInfo.root) loadGitPlan();
}

// ---- Plan de commits ----
// Lo que el documenter agrupó al cerrar una tarea, puesto donde se commitea.
// Vive en el servidor indexado por raíz de repositorio, así que cambiar de
// proyecto trae el suyo sin que el panel tenga que acordarse de nada.
async function loadGitPlan() {
  const dir = gitDir();
  if (!dir || !gitInfo || !gitInfo.repo) {
    if (gitPlan) {
      gitPlan = null;
      renderGit();
    }
    return;
  }
  const root = gitInfo.root;
  try {
    const data = await api(`/api/git/plan?path=${encodeURIComponent(dir)}`);
    // Pudo cambiar de carpeta mientras respondía
    if (gitInfo && gitInfo.root === root) {
      gitPlan = data;
      if (!gitBusy && !gitMenu && !gitPasting) renderGit();
    }
  } catch (_) {}
}

// Un commit del plan: prepara sus archivos y deja su mensaje escrito. Con
// `andCommit` además lo commitea y lo tacha de la lista.
async function applyPlanCommit(index, { andCommit = false } = {}) {
  const entry = gitPlan?.commits?.[index];
  if (!entry || gitBusy) return;

  setDraft(entry.message, { render: false });
  if (entry.files.length) {
    const data = await gitRun(() => api("/api/git/stage", { path: gitDir(), files: entry.files }));
    if (!data || data.ok === false) return;
  }
  if (!andCommit) return renderGit();

  const done = await gitRun(() => api("/api/git/commit", { path: gitDir(), message: entry.message, amend: false, all: false, then: null }));
  if (done && done.ok) {
    setDraft("", { render: false });
    await dropPlanCommit(index);
  }
}

async function dropPlanCommit(index) {
  try {
    gitPlan = await api("/api/git/plan", { path: gitDir(), index }, "DELETE");
  } catch (err) {
    return alert(err.message);
  }
  renderGit();
}

async function clearGitPlan() {
  if (!confirm("¿Borrar el plan de commits de este repositorio?")) return;
  try {
    gitPlan = await api("/api/git/plan", { path: gitDir() }, "DELETE");
  } catch (err) {
    return alert(err.message);
  }
  renderGit();
}

// El texto se manda tal cual: quien entiende los bloques COMMIT / ARCHIVOS /
// MENSAJE / FIN es el servidor, y así hay un solo parser.
async function saveGitPlan(text) {
  if (!text.trim()) return;
  try {
    gitPlan = await api("/api/git/plan", { path: gitDir(), text });
  } catch (err) {
    return alert(err.message);
  }
  gitPasting = false;
  gitPasteDraft = "";
  renderGit();
}

function renderGit() {
  const card = $("#gitCard");
  // Mientras corre una operación la tarjeta se apaga y no acepta clics
  card.classList.toggle("busy", gitBusy);
  const head = (right = "") => `
    <div class="row baseline between">
      <span class="field-label">CONTROL DE CÓDIGO</span>
      ${right}
    </div>`;

  if (!gitDir()) {
    card.innerHTML = head() + '<div class="git-empty">Sin carpeta abierta.</div>';
    return;
  }
  if (!gitInfo) {
    card.innerHTML = head() + '<div class="git-empty">Leyendo el repositorio…</div>';
    return;
  }
  if (!gitInfo.repo) {
    card.innerHTML = head() + '<div class="git-empty">Esta carpeta no está en un repositorio Git.</div>';
    return;
  }
  if (gitInfo.error) {
    card.innerHTML = head() + `<div class="git-empty error-text">${escapeHtml(gitInfo.error)}</div>`;
    return;
  }

  // Al cambiar de repositorio se recupera el borrador que tuviera guardado
  if (gitInfo.root !== gitDraftRoot) {
    gitDraftRoot = gitInfo.root;
    gitDraft = readDraft(gitInfo.root);
  }

  // El repintado por sondeo no puede perder lo que se está escribiendo
  const prevMsg = card.querySelector("#gitMsg");
  const keepFocus = prevMsg && document.activeElement === prevMsg
    ? { start: prevMsg.selectionStart, end: prevMsg.selectionEnd }
    : null;

  const files = gitInfo.files || [];
  const commits = gitInfo.commits || [];
  const staged = files.filter((f) => f.staged);
  const changed = files.filter((f) => !f.staged);
  const branch = gitInfo.detached ? "HEAD suelto" : gitInfo.branch || "sin rama";
  const arrows = [
    gitInfo.ahead ? `<span class="git-ahead" title="${gitInfo.ahead} commits sin subir">↑${gitInfo.ahead}</span>` : "",
    gitInfo.behind ? `<span class="git-behind" title="${gitInfo.behind} commits sin traer">↓${gitInfo.behind}</span>` : "",
  ].join("");

  const fileRow = (f) => `
    <div class="git-file ${f.kind}${f.staged && f.work !== " " ? " partial" : ""}">
      <button class="git-file-open" data-git-file="${escapeAttr(f.path)}" title="${escapeAttr(f.path)}${f.staged && f.work !== " " ? " — preparado, pero con más cambios encima" : ""}">
        <span class="git-name">${escapeHtml(f.name)}</span>
        <span class="git-dir">${escapeHtml(f.dir)}</span>
      </button>
      <button class="git-file-act" data-git-${f.staged ? "unstage" : "stage"}="${escapeAttr(f.path)}" title="${f.staged ? "Quitar del stage" : "Preparar"}">${f.staged ? "−" : "+"}</button>
      <span class="git-letter">${escapeHtml(f.letter)}</span>
    </div>`;

  const group = (title, list, action) => {
    if (!list.length) return "";
    const shown = list.slice(0, MAX_GIT_FILES).map(fileRow).join("");
    return `
      <div class="git-section">
        <div class="git-section-head">
          <span>${title}</span>
          <span class="row gap6 baseline">
            <button class="link-btn tiny" data-git-${action}-all>${action === "stage" ? "preparar todo" : "quitar todo"}</button>
            <span class="mono muted small">${list.length}</span>
          </span>
        </div>
        <div class="git-files">${shown}</div>
        ${list.length > MAX_GIT_FILES ? `<div class="git-more">y ${list.length - MAX_GIT_FILES} más</div>` : ""}
      </div>`;
  };

  const commitRows = commits
    .slice(0, MAX_GIT_COMMITS)
    .map(
      (c, i) => `
      <div class="git-commit ${c.unpushed ? "unpushed" : ""}">
        <span class="git-dot" aria-hidden="true"></span>
        <div class="git-commit-body">
          <div class="git-subject">${i === 0 && !gitInfo.detached ? `<span class="git-branch-chip">${escapeHtml(branch)}</span>` : ""}${escapeHtml(c.subject)}</div>
          <div class="git-meta">
            <span class="mono">${escapeHtml(c.short)}</span>
            <span>${escapeHtml(c.author)}</span>
            <span>${escapeHtml(formatAgo(c.date))}</span>
            ${c.unpushed ? '<span class="git-tag">sin subir</span>' : ""}
          </div>
        </div>
      </div>`
    )
    .join("");

  // Plan de commits del repositorio: cada entrada prepara sus archivos y escribe
  // su mensaje de un clic, o commitea directamente.
  const planSection = () => {
    if (gitPasting) {
      return `
        <div class="git-section git-plan">
          <div class="git-section-head"><span>Pegar plan de commits</span></div>
          <textarea class="git-paste mono" id="gitPaste" rows="6" placeholder="COMMIT: …&#10;ARCHIVOS:&#10;ruta/archivo.js&#10;MENSAJE:&#10;…&#10;FIN"></textarea>
          <div class="row gap6">
            <button class="btn primary" data-git-plan-save>Guardar plan</button>
            <button class="btn" data-git-plan-cancel>Cancelar</button>
          </div>
        </div>`;
    }
    const list = gitPlan?.commits || [];
    const paste = '<button class="link-btn tiny" data-git-plan-paste>pegar</button>';
    if (!list.length) {
      return `
        <div class="git-section git-plan">
          <div class="git-section-head"><span>Plan de commits</span>${paste}</div>
          <div class="git-clean">Sin plan. Pega el del documenter o deja que Claude Code lo registre.</div>
        </div>`;
    }
    const rows = list
      .map(
        (c, i) => `
        <div class="git-plan-item">
          <div class="git-plan-body">
            <div class="git-plan-title">${escapeHtml(c.title)}</div>
            <div class="git-plan-files">${c.files.length ? c.files.map((f) => `<span class="git-plan-file" title="${escapeAttr(f)}">${escapeHtml(f.split("/").pop())}</span>`).join("") : '<span class="git-plan-none">sin archivos</span>'}</div>
          </div>
          <div class="git-plan-acts">
            <button class="git-plan-act" data-git-plan-stage="${i}" title="Preparar sus archivos y escribir su mensaje"${gitBusy ? " disabled" : ""}>＋</button>
            <button class="git-plan-act go" data-git-plan-commit="${i}" title="Preparar y commitear"${gitBusy ? " disabled" : ""}>✓</button>
            <button class="git-plan-act drop" data-git-plan-drop="${i}" title="Quitar del plan">✕</button>
          </div>
        </div>`
      )
      .join("");
    return `
      <div class="git-section git-plan">
        <div class="git-section-head">
          <span>Plan de commits</span>
          <span class="row gap6 baseline">
            ${paste}
            <button class="link-btn tiny" data-git-plan-clear>limpiar</button>
            <span class="mono muted small">${list.length}</span>
          </span>
        </div>
        <div class="git-plan-list">${rows}</div>
      </div>`;
  };

  const branchBtn = `
    <span class="row gap6 baseline">
      <button class="git-branch mono" data-git-branches title="Cambiar de rama">${escapeHtml(branch)}${arrows}<span class="git-caret">⌄</span></button>
      <button class="git-sync" data-git-sync title="Traer y subir (sync)">⟳</button>
    </span>`;

  card.innerHTML =
    head(branchBtn) +
    `
    ${planSection()}
    <div class="git-commit-box">
      <textarea class="git-msg" id="gitMsg" rows="1" placeholder="Mensaje (⌘Enter para commitear)"></textarea>
      <div class="git-split">
        <button class="btn primary git-do" data-git-commit="plain"${gitBusy ? " disabled" : ""}>✓ Commit</button>
        <button class="btn primary git-do-more" data-git-commit-menu title="Más opciones"${gitBusy ? " disabled" : ""}>⌄</button>
      </div>
    </div>
    ${group("Cambios preparados", staged, "unstage")}
    ${group("Cambios", changed, "stage")}
    ${files.length ? "" : '<div class="git-section"><div class="git-clean">Árbol de trabajo limpio.</div></div>'}
    <div class="git-section">
      <div class="git-section-head">
        <span>Commits</span>
        <span class="mono muted small">${gitInfo.upstream ? escapeHtml(gitInfo.upstream) : "sin remoto"}</span>
      </div>
      ${commits.length ? `<div class="git-commits">${commitRows}</div>` : '<div class="git-clean">Todavía no hay commits.</div>'}
    </div>`;

  const msg = card.querySelector("#gitMsg");
  msg.value = gitDraft;
  growMsg(msg);
  if (keepFocus) {
    msg.focus();
    msg.setSelectionRange(keepFocus.start, keepFocus.end);
  }
  msg.addEventListener("input", () => {
    setDraft(msg.value, { render: false });
    growMsg(msg);
  });
  msg.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      doCommit("plain");
    }
  });

  // Un archivo cambiado abre en el editor, que es lo que uno quiere al verlo
  card.querySelectorAll("[data-git-file]").forEach((btn) => {
    btn.addEventListener("click", () => openGitFile(btn.dataset.gitFile));
  });
  card.querySelectorAll("[data-git-stage]").forEach((btn) => {
    btn.addEventListener("click", () => gitRun(() => api("/api/git/stage", { path: gitDir(), files: [btn.dataset.gitStage] })));
  });
  card.querySelectorAll("[data-git-unstage]").forEach((btn) => {
    btn.addEventListener("click", () => gitRun(() => api("/api/git/unstage", { path: gitDir(), files: [btn.dataset.gitUnstage] })));
  });
  card.querySelector("[data-git-stage-all]")?.addEventListener("click", () => gitRun(() => api("/api/git/stage", { path: gitDir(), all: true })));
  card.querySelector("[data-git-unstage-all]")?.addEventListener("click", () => gitRun(() => api("/api/git/unstage", { path: gitDir(), all: true })));
  card.querySelector("[data-git-branches]").addEventListener("click", (e) => openBranchMenu(e.currentTarget));
  card.querySelector("[data-git-sync]").addEventListener("click", () => doSync());
  card.querySelector("[data-git-commit]").addEventListener("click", () => doCommit("plain"));
  card.querySelector("[data-git-commit-menu]").addEventListener("click", (e) => openCommitMenu(e.currentTarget));

  // Plan de commits
  card.querySelectorAll("[data-git-plan-stage]").forEach((btn) => {
    btn.addEventListener("click", () => applyPlanCommit(Number(btn.dataset.gitPlanStage)));
  });
  card.querySelectorAll("[data-git-plan-commit]").forEach((btn) => {
    btn.addEventListener("click", () => applyPlanCommit(Number(btn.dataset.gitPlanCommit), { andCommit: true }));
  });
  card.querySelectorAll("[data-git-plan-drop]").forEach((btn) => {
    btn.addEventListener("click", () => dropPlanCommit(Number(btn.dataset.gitPlanDrop)));
  });
  card.querySelector("[data-git-plan-clear]")?.addEventListener("click", () => clearGitPlan());
  card.querySelector("[data-git-plan-paste]")?.addEventListener("click", () => {
    gitPasting = true;
    renderGit();
    card.querySelector("#gitPaste")?.focus();
  });

  const paste = card.querySelector("#gitPaste");
  if (paste) {
    paste.value = gitPasteDraft;
    paste.addEventListener("input", () => (gitPasteDraft = paste.value));
    card.querySelector("[data-git-plan-save]").addEventListener("click", () => saveGitPlan(paste.value));
    card.querySelector("[data-git-plan-cancel]").addEventListener("click", () => {
      gitPasting = false;
      gitPasteDraft = "";
      renderGit();
    });
  }
}

// La caja crece con el mensaje, hasta un tope: el carril no da para más
function growMsg(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

// ---- Operaciones ----
// Todas pasan por aquí: bloquean la tarjeta mientras corren, enseñan el texto de
// git si falló y dejan el estado recién leído que devuelve el servidor.
async function gitRun(call) {
  if (gitBusy) return null;
  closeGitMenu();
  gitBusy = true;
  renderGit();
  let data = null;
  try {
    data = await call();
    if (data && data.git) gitInfo = data.git;
    if (data && data.ok === false) alert(data.output || "git no pudo completar la operación.");
  } catch (err) {
    alert(err.message);
  } finally {
    gitBusy = false;
    renderGit();
    loadGit({ refresh: true, force: true });
  }
  return data;
}

async function doCommit(kind) {
  if (gitBusy) return;
  const message = gitDraft.trim();
  const amend = kind === "amend";
  if (!message && !amend) return alert("Escribe un mensaje de commit.");

  const files = gitInfo?.files || [];
  const staged = files.filter((f) => f.staged);
  const tracked = files.filter((f) => !f.untracked);
  // Sin nada preparado, se commitean todos los cambios rastreados, como VS Code
  const all = staged.length === 0;
  if (all && !tracked.length && !amend) return alert("No hay cambios que commitear.");
  if (all && tracked.length && !confirm(`No hay nada preparado.\n\n¿Commitear los ${tracked.length} archivos cambiados del árbol de trabajo?`)) return;
  if (amend && !confirm("Se va a rehacer el último commit (amend).\n\nSi ya lo habías subido, el push siguiente necesitará --force desde la terminal. ¿Seguir?")) return;

  const then = kind === "push" || kind === "sync" ? kind : null;
  const data = await gitRun(() => api("/api/git/commit", { path: gitDir(), message, amend, all, then }));
  if (data && data.ok) setDraft("");
}

const doSync = () => gitRun(() => api("/api/git/remote", { path: gitDir(), action: "sync" }));

function openCommitMenu(anchor) {
  openGitMenu(anchor, [
    { label: "Commit", onPick: () => doCommit("plain") },
    { label: "Commit (Amend)", onPick: () => doCommit("amend") },
    { separator: "" },
    { label: "Commit & Push", onPick: () => doCommit("push") },
    { label: "Commit & Sync", onPick: () => doCommit("sync") },
    { separator: "" },
    { label: "Traer (pull)", onPick: () => gitRun(() => api("/api/git/remote", { path: gitDir(), action: "pull" })) },
    { label: "Subir (push)", onPick: () => gitRun(() => api("/api/git/remote", { path: gitDir(), action: "push" })) },
  ]);
}

async function openBranchMenu(anchor) {
  const dir = gitDir();
  if (!dir || gitBusy) return;
  let data;
  try {
    data = await api(`/api/git/branches?path=${encodeURIComponent(dir)}`);
  } catch (err) {
    return alert(err.message);
  }
  const local = data.local || [];
  const remote = data.remote || [];

  const items = local.map((b) => ({
    label: b.name,
    hint: [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : "", b.gone ? "sin remoto" : ""].filter(Boolean).join(" "),
    checked: b.current,
    onPick: () => (b.current ? null : gitRun(() => api("/api/git/checkout", { path: dir, branch: b.name }))),
  }));

  if (remote.length) {
    items.push({ separator: "Remotas" });
    // Sacar una remota crea la local que la sigue: es lo que hace VS Code
    remote.forEach((b) =>
      items.push({
        label: b.shortName,
        hint: b.name,
        onPick: () => gitRun(() => api("/api/git/checkout", { path: dir, branch: b.name, track: true })),
      })
    );
  }
  items.push({ separator: "" });
  items.push({ label: "Crear rama nueva…", onPick: () => createBranch(dir) });

  openGitMenu(anchor, items, { filter: local.length + remote.length >= BRANCH_FILTER_FROM });
}

function createBranch(dir) {
  const name = (prompt("Nombre de la rama nueva (sale de la rama actual):") || "").trim();
  if (!name) return;
  gitRun(() => api("/api/git/checkout", { path: dir, branch: name, create: true }));
}

// ---- Menú flotante ----
// Lo usan el selector de rama y el botón de commit. Va en <body> y en position
// fixed: la tarjeta vive en un carril con scroll, y un hijo suyo se iría con él.
function openGitMenu(anchor, items, { filter = false } = {}) {
  closeGitMenu();

  const menu = document.createElement("div");
  menu.className = "float-menu";

  let input = null;
  if (filter) {
    input = document.createElement("input");
    input.className = "float-menu-filter";
    input.placeholder = "Filtrar ramas…";
    menu.appendChild(input);
  }

  const list = document.createElement("div");
  list.className = "float-menu-list";
  menu.appendChild(list);

  items.forEach((item) => {
    if (item.separator !== undefined) {
      const sep = document.createElement("div");
      sep.className = "float-menu-sep";
      sep.textContent = item.separator;
      list.appendChild(sep);
      return;
    }
    const btn = document.createElement("button");
    btn.className = `float-menu-item${item.checked ? " checked" : ""}`;
    btn.dataset.label = item.label.toLowerCase();
    btn.innerHTML = `<span class="float-menu-label">${escapeHtml(item.label)}</span>${item.hint ? `<span class="float-menu-hint">${escapeHtml(item.hint)}</span>` : ""}`;
    btn.addEventListener("click", () => {
      closeGitMenu();
      item.onPick?.();
    });
    list.appendChild(btn);
  });

  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  // Cabe hacia abajo y hacia la derecha, o se pega al borde contrario
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  menu.style.top = r.bottom + 6 + h < window.innerHeight ? `${r.bottom + 6}px` : `${Math.max(8, r.top - 6 - h)}px`;

  const onDown = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeGitMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeGitMenu();
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", closeGitMenu);

  if (input) {
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      list.querySelectorAll(".float-menu-item").forEach((b) => {
        b.classList.toggle("hidden", q && !b.dataset.label.includes(q));
      });
    });
    input.focus();
  }

  gitMenu = {
    close() {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", closeGitMenu);
      menu.remove();
    },
  };
}

function closeGitMenu() {
  if (!gitMenu) return;
  const m = gitMenu;
  gitMenu = null;
  m.close();
}

// Las rutas de git son relativas a la raíz del repo, no a la carpeta abierta
async function openGitFile(relPath) {
  if (!gitInfo?.root) return;
  showTab("editor");
  try {
    await CodeEditor.openFile(`${gitInfo.root}/${relPath}`);
  } catch (_) {
    // Un archivo borrado o fuera de los proyectos abiertos no se puede abrir
  }
}

// "hace 3 h", "hace 2 d": en el carril no cabe una fecha entera
function formatAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d} d`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `hace ${mo} mes${mo === 1 ? "" : "es"}` : `hace ${Math.floor(mo / 12)} a`;
}

// ================= Cola por modelo =================
const maxParallel = () => queueInfo.max_parallel || config.max_parallel || 1;

// "qwen/qwen3-4b-2507" → "qwen3-4b-2507": en el panel el editor ya no cabe
const shortModel = (id) => String(id || "").split("/").pop();

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
  renderSessionUI();

  // Si quedaron sesiones abiertas (p. ej. tras recargar), volver a conectarlas.
  // La de Claude Code manda: el dock sigue a su carpeta.
  const liveClaude = claudeSessions().find((s) => !s.exited);
  if (liveClaude) attachClaudeSession(liveClaude.id);
  else {
    const liveShell = sessions.find((s) => s.kind === "shell" && !s.exited);
    if (liveShell) followDock(liveShell.cwd);
  }

  await refreshStatus();
  connectStream();
  setInterval(refreshStatus, 6000);
  // Git cambia por fuera del panel (Claude Code, la terminal, otro editor):
  // la única forma de enterarse es volver a preguntar
  renderGit();
  loadGit();
  setInterval(() => {
    if (!document.hidden) loadGit();
  }, GIT_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadGit();
  });
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
