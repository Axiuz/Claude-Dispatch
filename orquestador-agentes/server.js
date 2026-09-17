const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const pty = require("node-pty");
const { buildGraph } = require("./codegraph");
const { COLUMNS, COLUMN_AFTER_RUN, columnFor, placeStep } = require("./kanban");
const safepath = require("./safepath");
const claudeusage = require("./claudeusage");

const DEFAULT_DATA_DIR = path.join(__dirname, "data");
// La app de macOS pasa ORQ_DATA_DIR para guardar los datos fuera del bundle
// y que sobrevivan al reemplazar la app. Se siembra con los valores por defecto.
const DATA_DIR = process.env.ORQ_DATA_DIR || DEFAULT_DATA_DIR;
if (DATA_DIR !== DEFAULT_DATA_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of ["agents.json", "config.json"]) {
    const dest = path.join(DATA_DIR, file);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(DEFAULT_DATA_DIR, file), dest);
  }
}
const AGENTS_PATH = path.join(DATA_DIR, "agents.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
// Lista de carpetas recientes. No se siembra: lleva rutas reales del usuario.
const PROJECTS_PATH = path.join(DATA_DIR, "projects.json");
// El tablero sí va a disco: desde que se pueden añadir tarjetas a mano, contiene
// trabajo del usuario y no solo el reflejo de lo que hace Claude Code.
const PLAN_PATH = path.join(DATA_DIR, "plan.json");

const loadJSON = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));
const saveJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2));

let config = loadJSON(CONFIG_PATH);
let agentsFile = loadJSON(AGENTS_PATH);

const getAgents = () => agentsFile.agents;
const findAgent = (id) => getAgents().find((a) => a.id === id);

// ============ Estado en vivo ============
// runs: historial + estado actual de cada delegación
let runs = [];
// currentPlan: el plan aprobado que Claude Code está ejecutando. A diferencia de
// los runs, sobrevive al reinicio (ver PLAN_PATH).
let currentPlan = fs.existsSync(PLAN_PATH) ? loadJSON(PLAN_PATH) : null;
// clientes SSE conectados (el panel)
let sseClients = [];

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((res) => {
    try {
      res.write(data);
    } catch (_) {}
  });
}

function createRun({ agentId, model, prompt, source, meta }) {
  const run = {
    id: crypto.randomUUID(),
    agentId,
    model: model || config.model,
    prompt,
    source: source || "desconocido",
    meta: meta || {},
    stepId: meta?.step_id || null,
    // Nace en cola: pasa a "running" cuando le toca turno (ver takeSlot)
    status: "queued",
    response: "",
    reasoning: "",
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    queuedMs: null,
    tokensApprox: null,
  };
  runs.unshift(run);
  if (runs.length > (config.max_runs_kept || 300)) runs.length = config.max_runs_kept;

  // Si el run pertenece a un paso del plan, marcar ese paso como en curso
  if (run.stepId) setStepColumn(run.stepId, "progress", { runId: run.id, error: false, note: null });

  broadcast("run:start", run);
  return run;
}

function updateRun(run, patch) {
  Object.assign(run, patch);
  if (run.stepId && ["done", "error", "cancelled"].includes(run.status)) {
    // Lo que escribe un agente local no pasa a HECHO solo: va a REVISIÓN, que es
    // donde el usuario lo comprueba. Un run cancelado vuelve a PENDIENTE.
    const column = COLUMN_AFTER_RUN[run.status];
    setStepColumn(run.stepId, column, {
      runId: run.id,
      durationMs: run.durationMs,
      error: run.status === "error",
      note: run.status === "cancelled" ? "cancelado" : run.status === "error" ? truncateNote(run.error) : null,
    });
  }
  broadcast("run:update", run);
}

// ============ Tablero kanban ============
// Las columnas y la colocación de tarjetas viven en kanban.js, sin estado.
const MAX_STEPS = 200;
const truncateNote = (text) => (text ? String(text).split("\n")[0].slice(0, 120) : null);
const place = (step, column, index) => placeStep(currentPlan.steps, step, column, index);

function savePlan() {
  try {
    if (currentPlan) saveJSON(PLAN_PATH, currentPlan);
    else if (fs.existsSync(PLAN_PATH)) fs.rmSync(PLAN_PATH);
  } catch (err) {
    console.error("No se pudo guardar el plan:", err.message);
  }
}

// Todo cambio en el tablero pasa por aquí: se guarda y se avisa al panel.
function planChanged() {
  savePlan();
  broadcast("plan:update", currentPlan);
}

function setStepColumn(stepId, column, extra = {}) {
  if (!currentPlan) return;
  const step = currentPlan.steps.find((s) => s.id === stepId);
  if (!step) return;
  Object.assign(step, extra);
  if (column && column !== step.column) place(step, column, 0);
  planChanged();
}

// ============ Proyectos recientes ============
// Carpetas abiertas desde el panel o registradas por Claude Code al mandar un plan.
// Es lo único de esta sección que va a disco; las sesiones de terminal viven en memoria.
const MAX_PROJECTS = 30;
let projects = fs.existsSync(PROJECTS_PATH) ? loadJSON(PROJECTS_PATH) : [];

const resolveDir = safepath.expandPath;

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

// Lee la rama directo de .git/HEAD, sin lanzar procesos de git
function gitBranch(dir) {
  try {
    let gitDir = path.join(dir, ".git");
    if (fs.statSync(gitDir).isFile()) {
      // worktree o submódulo: .git es un archivo "gitdir: <ruta>"
      const m = fs.readFileSync(gitDir, "utf-8").match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim();
    const ref = head.match(/^ref: refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 7);
  } catch (_) {
    return null;
  }
}

function projectView(p) {
  const exists = isDirectory(p.path);
  const session = [...sessions.values()].find((s) => s.cwd === p.path && !s.exited);
  return {
    ...p,
    exists,
    branch: exists ? gitBranch(p.path) : null,
    sessionId: session?.id || null,
  };
}

const listProjects = () => projects.map(projectView);
const broadcastProjects = () => broadcast("projects:updated", listProjects());

function touchProject(dir) {
  const now = new Date().toISOString();
  const existing = projects.find((p) => p.path === dir);
  if (existing) existing.lastOpenedAt = now;
  else projects.push({ path: dir, name: path.basename(dir), addedAt: now, lastOpenedAt: now });
  projects.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  projects = projects.slice(0, MAX_PROJECTS);
  saveJSON(PROJECTS_PATH, projects);
  broadcastProjects();
}

// ============ Sesiones de terminal (una shell dentro del panel) ============
// Una sesión = un pty con la shell de login del usuario abierta en la carpeta del
// proyecto. Es una terminal normal: quien quiera Claude Code lo escribe él mismo.
const SCROLLBACK_BYTES = 256 * 1024;
const sessions = new Map();

// Con pnpm el postinstall de node-pty no siempre deja spawn-helper ejecutable,
// y sin eso falla con "posix_spawnp failed"
try {
  const ptyDir = path.dirname(require.resolve("node-pty/package.json"));
  const helper = path.join(ptyDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
} catch (_) {}

function sessionView(s) {
  return { id: s.id, cwd: s.cwd, name: s.name, startedAt: s.startedAt, exited: s.exited, exitCode: s.exitCode };
}

const broadcastSessions = () => broadcast("terminals:updated", [...sessions.values()].map(sessionView));

function writeSse(res, event, payload) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch (_) {}
}

function startSession(cwd, cols, rows) {
  const shell = process.env.SHELL || os.userInfo().shell || "/bin/zsh";
  const env = { ...process.env, SHELL: shell, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete env.ORQ_DATA_DIR;
  delete env.ORQ_APP_ONLY;

  // -l -i: shell de login e interactiva, con el perfil del usuario cargado. Sin
  // -c: no lanzamos ningún programa, es la terminal de siempre en esa carpeta.
  const proc = pty.spawn(shell, ["-l", "-i"], {
    name: "xterm-256color",
    cwd,
    env,
    cols,
    rows,
  });

  const s = {
    id: crypto.randomUUID(),
    cwd,
    name: path.basename(cwd),
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    proc,
    buffer: "",
    pending: "",
    flushTimer: null,
    clients: new Set(),
  };

  // Agrupamos la salida en ráfagas de ~16 ms: un programa a pantalla completa
  // redibuja mucho y un evento SSE por chunk satura la conexión
  proc.onData((data) => {
    s.buffer += data;
    if (s.buffer.length > SCROLLBACK_BYTES) s.buffer = s.buffer.slice(-SCROLLBACK_BYTES);
    s.pending += data;
    if (s.flushTimer) return;
    s.flushTimer = setTimeout(() => {
      s.flushTimer = null;
      const chunk = s.pending;
      s.pending = "";
      s.clients.forEach((res) => writeSse(res, "data", chunk));
    }, 16);
  });

  proc.onExit(({ exitCode }) => {
    s.exited = true;
    s.exitCode = exitCode;
    s.clients.forEach((res) => writeSse(res, "exit", { exitCode }));
    broadcastSessions();
    broadcastProjects();
  });

  sessions.set(s.id, s);
  broadcastSessions();
  return s;
}

function killSession(s) {
  if (!s.exited) {
    try {
      s.proc.kill();
    } catch (_) {}
  }
  s.clients.forEach((res) => {
    try {
      res.end();
    } catch (_) {}
  });
  sessions.delete(s.id);
}

// ============ Tokens de Claude Code ============
// Lo que gastan los agentes locales lo sabemos por los runs; lo que gasta Claude
// Code no pasa por aquí, así que se lee de sus propios transcripts. El tracker
// avisa solo cuando cambia algo, y eso va derecho al panel.
const usageTracker = claudeusage.createTracker({
  onChange: (snapshot) => broadcast("claude:usage", snapshot),
});
usageTracker.start();

// Que ninguna sesión sobreviva al orquestador (launcher.sh stop manda SIGTERM)
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    sessions.forEach(killSession);
    usageTracker.stop();
    process.exit(0);
  });
}

const clampSize = (n, fallback) => {
  const v = parseInt(n, 10);
  return Number.isFinite(v) && v >= 2 && v <= 1000 ? v : fallback;
};

// ============ Cola de delegaciones ============
// Mandarle varias peticiones juntas al mismo modelo no las hace más rápidas,
// multiplica el KV cache y en 16 GB unificados acaba en swap. Por eso hay una
// cola por modelo: la delegación pide turno en el carril de SU modelo, y la que
// no lo consigue espera en "queued" hasta que termine otra de ese mismo modelo.
// Con dos modelos cargados (uno por par de agentes) dos runs corren de verdad
// a la vez sin pelearse por el mismo slot de LM Studio.
const RUN_DEFAULTS = {
  max_parallel: 1, // por modelo, no en total: igualarlo a Max Concurrency de LM Studio
  stall_timeout_ms: 90000, // sin recibir un solo token del modelo
  run_timeout_ms: 600000, // tope duro por run, por si el modelo entra en bucle
  max_prompt_chars: 16000, // ~4000 tokens: deja sitio a la respuesta en 8192 de contexto
};
const CANCELLED = "Cancelado desde el panel";
const MAX_BATCH = 12; // tareas por lote en /delegate; la cola las sirve de a max_parallel

// Todos estos valores viven en config.json y se pueden cambiar desde el panel
const setting = (key) => (Number(config[key]) > 0 ? Number(config[key]) : RUN_DEFAULTS[key]);

// Un carril por modelo. Cada modelo cargado en LM Studio atiende de a una
// petición (Max Concurrency 1), así que dos runs del mismo modelo se estorban;
// dos de modelos distintos no. De ahí sale el paralelismo real: el coder de
// Qwen y el documenter de Gemma corren a la vez, dos coders se encolan.
const lanes = new Map(); // modelo -> { active, queue: [tickets] }
// Lo que está corriendo o esperando turno, para poder cancelarlo por id
const inFlight = new Map();

function laneFor(model) {
  let lane = lanes.get(model);
  if (!lane) lanes.set(model, (lane = { active: 0, queue: [] }));
  return lane;
}

// Un carril sin nada corriendo ni esperando no se muestra ni ocupa memoria
function dropLaneIfIdle(model) {
  const lane = lanes.get(model);
  if (lane && !lane.active && !lane.queue.length) lanes.delete(model);
}

const queueState = () => {
  const models = [...lanes.entries()].map(([model, lane]) => ({
    model,
    active: lane.active,
    queued: lane.queue.length,
  }));
  return {
    // Los totales siguen ahí: el panel viejo y /api/status los leen igual
    active: models.reduce((n, m) => n + m.active, 0),
    queued: models.reduce((n, m) => n + m.queued, 0),
    max_parallel: setting("max_parallel"), // por modelo, no global
    models,
  };
};
const broadcastQueue = () => broadcast("queue:updated", queueState());

// Devuelve null si hay turno libre en ese modelo, o un ticket que se resuelve
// cuando lo haya
function takeSlot(model) {
  const lane = laneFor(model);
  if (lane.active < setting("max_parallel")) {
    lane.active++;
    return null;
  }
  const ticket = { model };
  ticket.promise = new Promise((resolve, reject) => {
    ticket.resolve = resolve;
    ticket.reject = reject;
  });
  lane.queue.push(ticket);
  return ticket;
}

// Al terminar un run su turno pasa al primero que espera por ese mismo modelo,
// no se libera: el turno de Qwen no sirve para arrancar un run de Gemma.
function freeSlot(model) {
  const lane = laneFor(model);
  const next = lane.queue.shift();
  if (next) next.resolve();
  else lane.active = Math.max(0, lane.active - 1);
  dropLaneIfIdle(model);
  broadcastQueue();
}

// Si se sube max_parallel desde el panel, los que esperan entran en ese momento;
// si no, no arrancaría ninguno hasta que terminara el run en curso.
function fillFreeSlots() {
  for (const [model, lane] of lanes) {
    while (lane.queue.length && lane.active < setting("max_parallel")) {
      lane.active++;
      lane.queue.shift().resolve();
    }
    dropLaneIfIdle(model);
  }
  broadcastQueue();
}

function dropFromQueue(ticket) {
  const lane = lanes.get(ticket.model);
  if (!lane) return;
  const i = lane.queue.indexOf(ticket);
  if (i >= 0) lane.queue.splice(i, 1);
  dropLaneIfIdle(ticket.model);
}

// El prompt entero entra al contexto del modelo: si se pasa, LM Studio lo trunca
// por dentro o devuelve error. Es mejor rechazarlo aquí y decir por qué.
function promptTooLong(prompt) {
  const max = setting("max_prompt_chars");
  if (typeof prompt !== "string" || prompt.length <= max) return null;
  return `El prompt tiene ${prompt.length} caracteres y el tope es ${max} (~${Math.round(
    max / 4
  )} tokens). Pártelo en trozos o manda un resumen en lugar del archivo entero.`;
}

// ============ Llamada a LM Studio (con streaming) ============
async function runAgent({ agent, prompt, source, meta, overrides = {} }) {
  // Cada agente puede fijar su modelo; si no lo hace, usa el de config.json.
  // Se resuelve aquí y no al armar el body porque decide en qué carril espera.
  const model = overrides.model || agent.model || config.model;
  const run = createRun({ agentId: agent.id, model, prompt, source, meta });
  const controller = new AbortController();
  const entry = { run, ticket: null, reason: null };

  // fetch() no dice por qué se abortó: el motivo se guarda antes de abortar
  entry.cancel = (reason) => {
    entry.reason = reason;
    if (entry.ticket) {
      const ticket = entry.ticket;
      entry.ticket = null;
      dropFromQueue(ticket);
      ticket.reject(new Error(reason));
    }
    controller.abort();
  };
  inFlight.set(run.id, entry);

  const queuedAt = Date.now();
  let started = queuedAt;
  let hasSlot = false;
  let stallTimer = null;
  let totalTimer = null;

  try {
    entry.ticket = takeSlot(model);
    if (entry.ticket) {
      broadcastQueue();
      await entry.ticket.promise; // se resuelve cuando otro run libera su turno
      entry.ticket = null;
    }
    hasSlot = true;
    broadcastQueue();

    // El tiempo se cuenta desde que entra al modelo: la espera en cola va aparte
    started = Date.now();
    updateRun(run, {
      status: "running",
      startedAt: new Date(started).toISOString(),
      queuedMs: started - queuedAt,
    });

    const body = {
      model,
      messages: [
        { role: "system", content: agent.system_prompt },
        { role: "user", content: prompt },
      ],
      temperature: overrides.temperature ?? agent.temperature ?? 0.3,
      max_tokens: overrides.max_tokens ?? agent.max_tokens ?? 1024,
      stream: true,
    };

    const stallMs = Number(agent.stall_timeout_ms) > 0 ? Number(agent.stall_timeout_ms) : setting("stall_timeout_ms");
    const totalMs = Number(agent.run_timeout_ms) > 0 ? Number(agent.run_timeout_ms) : setting("run_timeout_ms");

    // Dos relojes. El de inactividad se rearma con cada token, así que un run
    // lento sigue vivo y solo muere el que se quedó colgado; el total es el tope
    // duro. Sin esto el run se queda en "running" para siempre y ocupa su turno.
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => entry.cancel(`LM Studio no envió nada en ${Math.round(stallMs / 1000)} s`),
        stallMs
      );
    };
    totalTimer = setTimeout(() => entry.cancel(`El run pasó del tope de ${Math.round(totalMs / 1000)} s`), totalMs);
    armStall();

    const res = await fetch(`${config.lmstudio_url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LM Studio respondió ${res.status}: ${text.slice(0, 300)}`);
    }

    // Leer el stream SSE de LM Studio y reemitir el texto al panel en vivo
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let reasoning = "";
    let lastFlush = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armStall();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta || {};
          // Los modelos con razonamiento mandan lo que "piensan" aparte del texto
          // (LM Studio usa reasoning_content). Se guarda para verlo en el panel.
          const thought = delta.reasoning_content || delta.reasoning;
          if (thought) reasoning += thought;
          if (delta.content) full += delta.content;
          if (thought || delta.content) {
            // throttle: emitimos al panel cada ~120ms para no saturar
            const now = Date.now();
            if (now - lastFlush > 120) {
              lastFlush = now;
              run.response = full;
              run.reasoning = reasoning;
              broadcast("run:token", { id: run.id, partial: full, reasoning });
            }
          }
        } catch (_) {}
      }
    }

    const durationMs = Date.now() - started;
    updateRun(run, {
      status: "done",
      response: full,
      reasoning,
      finishedAt: new Date().toISOString(),
      durationMs,
      tokensApprox: Math.round(full.length / 4),
    });

    return { content: full, durationMs, runId: run.id };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = entry.reason || String(err.message || err);
    updateRun(run, {
      // Cancelar es una decisión, no un fallo: no cuenta en la tasa de error
      status: entry.reason === CANCELLED ? "cancelled" : "error",
      error: message,
      finishedAt: new Date().toISOString(),
      durationMs,
    });
    throw new Error(message);
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(totalTimer);
    inFlight.delete(run.id);
    if (hasSlot) freeSlot(model);
    else broadcastQueue();
  }
}

// ============ App ============
const app = express();

// ---- Seguridad: solo este Mac ----
// El servidor escucha en 127.0.0.1 (ver app.listen), así que nadie de la red
// puede conectarse. Además rechazamos:
// - Host ajeno: evita DNS rebinding (una web que resuelve su dominio a 127.0.0.1)
// - Origin ajeno: evita que una página abierta en el navegador llame a la API
// curl y Claude Code no mandan Origin; el panel manda el suyo, que es local.
const PORT = config.app_port || 3131;
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
app.use((req, res, next) => {
  const host = req.get("host");
  const origin = req.get("origin");
  const hostOk = LOCAL_HOSTS.has(host);
  const originOk = !origin || LOCAL_HOSTS.has(origin.replace(/^http:\/\//, ""));
  if (hostOk && originOk) return next();
  res.status(403).json({ error: "Solo se aceptan peticiones locales" });
});

app.use(express.json({ limit: "4mb" }));
// En la app de macOS el panel solo se muestra en su ventana, no en el navegador.
// La API sigue abierta: Claude Code la necesita.
if (process.env.ORQ_APP_ONLY) {
  const isApiPath = (p) => p.startsWith("/api/") || p.startsWith("/agent/") || p === "/delegate";
  app.use((req, res, next) => {
    if (isApiPath(req.path) || (req.get("user-agent") || "").includes("ClaudeDispatchApp")) return next();
    res.status(403).type("text").send("El panel del orquestador solo está disponible en la app Claude Dispatch.");
  });
}
app.use(express.static(path.join(__dirname, "public")));
// xterm.js se sirve tal cual desde node_modules: sin build step
// Algunos paquetes (monaco) no exponen su package.json en el campo "exports",
// así que si require.resolve falla se cae a la carpeta de node_modules de al lado.
const pkgDir = (name) => {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch (_) {
    return path.join(__dirname, "node_modules", name);
  }
};
app.use("/vendor/xterm", express.static(path.join(pkgDir("@xterm/xterm"), "lib")));
app.use("/vendor/xterm", express.static(path.join(pkgDir("@xterm/xterm"), "css")));
app.use("/vendor/xterm", express.static(path.join(pkgDir("@xterm/addon-fit"), "lib")));
// Monaco (el editor de VS Code) igual: su build AMD se carga tal cual desde disco
app.use("/vendor/monaco", express.static(path.join(pkgDir("monaco-editor"), "min/vs")));

// ---- SSE: el panel se suscribe aquí para ver todo en vivo ----
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.push(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch (_) {}
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// ---- Instrucciones para Claude Code ----
// Fuente única: la pestaña Conexión las muestra para copiarlas y cada sesión de
// terminal las recibe con --append-system-prompt. Si cambias la API, cámbialas aquí.
function buildInstructions(project) {
  const port = config.app_port || 3131;
  const enabled = getAgents().filter((a) => a.enabled !== false);
  const has = (id) => enabled.some((a) => a.id === id);
  const list = enabled
    .map((a) => `- ${a.id} (${a.name}): ${a.use_when}${a.model && a.model !== config.model ? ` [modelo: ${a.model}]` : ""}`)
    .join("\n");

  // Solo se nombran los agentes activos: si uno está apagado, Claude no debe contar con él
  const defaultRules = [
    has("tester") &&
      "- tester: si escribiste o cambiaste lógica, pídele los tests unitarios de esa\n  lógica. Revísalos y ajústalos tú antes de integrarlos.",
    has("reviewer")
      ? "- reviewer: antes de dar la tarea por terminada, mándale el diff (o las partes\n  clave si es muy grande). Valora sus observaciones; no todas serán correctas."
      : "- La revisión la haces tú, que sí ves el repo completo: el agente reviewer está\n  desactivado. Repasa tu propio diff antes de darme la tarea por terminada.",
    has("documenter")
      ? "- documenter: si hay que documentar, tú escribes el resumen de hechos (qué se\n  hizo, por qué, archivos, API) y él redacta docstrings o secciones. Tú revisas e\n  integras."
      : "- La documentación la escribes tú: el agente documenter está desactivado.",
    has("explainer") && "- explainer: opcional, para resumir código ajeno cuando necesites orientarte.",
    ...enabled
      .filter((a) => !["coder", "tester", "reviewer", "documenter", "explainer"].includes(a.id))
      .map((a) => `- ${a.id}: úsalo cuando la tarea encaje con "${a.use_when}".`),
  ].filter(Boolean);
  const defaultUse = defaultRules.length
    ? defaultRules.join("\n")
    : "- No hay agentes activos: haz todo tú y avísame.";

  const sessionNote = project
    ? `
## Esta sesión
Corres dentro de Claude Dispatch, en la carpeta ${project}.
Cuando registres un plan usa "project": "${project}".
`
    : "";

  return `# Flujo con agentes de IA locales

Eres el orquestador: tú lees mis archivos y tocas mi código. Tienes agentes locales
en LM Studio a tu disposición para lo que necesites. Son modelos pequeños: no leen
archivos ni recuerdan nada, todo el contexto se lo pasas tú en el prompt.
${sessionNote}
## Agentes disponibles
${list}

## Tú eres el coder principal
Escribes tú el código: funciones, lógica, integración y cambios en varios archivos.
El agente coder es tu refuerzo solo cuando hay demasiado código que escribir:
- Mucho volumen mecánico y autocontenido, del orden de 150 líneas o más: CRUD de
  varias entidades, DTOs o schemas en serie, mappers, fixtures, datos de prueba.
- Antes de delegarlo define tú la estructura: firmas, tipos y un ejemplo del
  patrón. El coder rellena; tú revisas e integras.
- Si es menos que eso, o requiere entender el proyecto, lo escribes tú.

## Uso de agentes por defecto
${defaultUse}
Excepciones, las únicas válidas para saltarte un agente de la lista anterior:
- El cambio es trivial: menos de ~20 líneas y sin lógica nueva.
- LM Studio no responde (lo compruebas al empezar).
- Te pido explícitamente no usar agentes.
Si aplicas una excepción, di en una línea qué agente omites y cuál excepción es.

"El agente no puede leer archivos" o "no tiene el contexto" NO son motivos para no
delegar: tu trabajo es leer, resumir y pasarle el contexto. Si el material es
grande, pártelo en trozos de ~300 líneas o pásale tu resumen.

Nunca delegues decisiones de arquitectura ni la implementación de seguridad,
auth o credenciales (sí puedes pedir revisión).

## Ciclo de trabajo

1) PLAN — Para tareas de más de un paso, entra en plan mode, lee lo necesario y
   arma el plan indicando qué paso hace cada quien. Preséntamelo y espera mi
   aprobación.

2) REGISTRO — Cuando apruebe, registra el plan en mi panel:
   curl -s -X POST http://localhost:${port}/api/plan \\
     -H "Content-Type: application/json" \\
     -d '{"title":"...","goal":"...","project":"<ruta absoluta del repo>","steps":[
           {"description":"Leer X","agent":null},
           {"description":"Generar Y","agent":"coder"}
         ]}'
   ("agent": null = lo haces tú; "project" = la carpeta donde trabajas)

   El tablero tiene cinco columnas: todo, progress, review, done, approved.
   Los pasos entran en todo; un run los pasa solo a progress y, al terminar, a
   review — es ahí donde yo compruebo lo que escribió el agente. A done y
   approved los muevo yo desde el panel.

3) EJECUCIÓN
   Paso tuyo:
     curl -s -X POST http://localhost:${port}/api/plan/step/step-1 \\
       -H "Content-Type: application/json" -d '{"status":"done"}'
   (también acepta {"column":"review"} si quieres dejarlo para que yo lo mire)

   Paso delegado (incluye el contexto en el prompt):
     curl -s -X POST http://localhost:${port}/agent/{id} \\
       -H "Content-Type: application/json" \\
       -d '{"prompt":"Contexto:\\n<código>\\n\\nTarea:\\n<qué>",
            "task_label":"etiqueta","step_id":"step-2"}'

   Varios pasos independientes en un solo lote (hasta ${MAX_BATCH}):
     curl -s -X POST http://localhost:${port}/delegate \\
       -H "Content-Type: application/json" \\
       -d '{"tasks":[{"agent":"tester","prompt":"...","step_id":"step-3"}]}'
   Mándalos todos juntos sin repartirlos tú: cada agente corre en el modelo que
   tiene asignado y hay una cola por modelo, de ${setting("max_parallel")} a la vez.
   Tareas de agentes con modelos distintos corren en paralelo; dos del mismo modelo
   se encolan. Mandar más peticiones juntas al mismo modelo no las acelera.

4) REVISIÓN — Revisa cada respuesta antes de integrarla: el modelo es pequeño y se
   equivoca más que tú. Si viene mal, corrígela tú; no reenvíes la misma tarea al
   agente. Al terminar, repórtame qué cambió y qué dudas tienes.
   Cierra con: curl -s -X DELETE http://localhost:${port}/api/plan

## Reglas
- Al empezar cada tarea, consulta los agentes activos y el estado:
    curl -s http://localhost:${port}/api/manifest
    curl -s http://localhost:${port}/api/status
  La lista de agentes puede haber cambiado desde que se abrió esta sesión: si el
  manifest difiere de "Agentes disponibles", manda el manifest.
  Si "reachable" es false, avísame y sigue sin delegar.
- Pega el código relevante en el prompt del agente; no describas el archivo.
- El prompt tiene un tope de ${setting("max_prompt_chars")} caracteres (~${Math.round(
    setting("max_prompt_chars") / 4
  )} tokens). Si te pasas recibes un 413: parte el contexto en trozos.
- Un run sin respuesta del modelo se corta solo y queda como error; no se queda
  colgado. Si eso pasa, el modelo está saturado: sigue tú y avísame.
- Incluye siempre "task_label" y "step_id": es lo que veo en mi panel.`;
}

app.get("/api/instructions", (req, res) => res.json({ text: buildInstructions() }));

// ---- Manifest: lo que Claude Code consulta para saber a quién llamar ----
app.get("/api/manifest", (req, res) => {
  res.json({
    description:
      "Agentes de IA locales disponibles para delegación. Elige el agente cuyo 'use_when' corresponda a la tarea y llama a POST /agent/{id} con {\"prompt\": \"...\"}.",
    base_url: `http://localhost:${config.app_port}`,
    agents: getAgents()
      .filter((a) => a.enabled !== false)
      .map((a) => ({
        id: a.id,
        name: a.name,
        use_when: a.use_when,
        model: a.model || config.model,
        endpoint: `POST /agent/${a.id}`,
      })),
    notes: [
      "Body siempre: {\"prompt\": \"<tarea>\"}. Opcional: temperature, max_tokens.",
      "Respuesta: {\"content\": \"...\", \"durationMs\": N, \"runId\": \"...\"}",
      "Puedes llamar varios agentes en paralelo (el servidor local acepta peticiones concurrentes).",
      "Incluye en el body 'task_label' con una etiqueta corta de la tarea para que se vea claro en el panel.",
      "IMPORTANTE: los agentes NO leen archivos. Tú lees el código y se lo pegas en el prompt.",
      "Flujo con plan: registra el plan aprobado con POST /api/plan, luego incluye 'step_id' en cada llamada a un agente para que el panel muestre el avance.",
    ],
    plan_flow: {
      register:
        'POST /api/plan  {"title": "...", "goal": "...", "project": "<ruta absoluta del repo>", "steps": [{"description": "...", "agent": "coder"}]}',
      link_run: 'Al invocar un agente, incluye "step_id": "step-1" en el body',
      queue: `Las delegaciones se encolan: corren ${setting("max_parallel")} a la vez, hasta ${MAX_BATCH} por lote`,
      cancel: "DELETE /api/runs/:id — aborta un run en curso o en cola",
      manual_step: 'POST /api/plan/step/{stepId}  {"status": "done", "note": "..."}  — para pasos que haces tú, sin agente',
      clear: "DELETE /api/plan — al terminar",
    },
  });
});

// ---- Endpoint genérico: cualquier agente por id ----
app.post("/agent/:id", async (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) {
    return res.status(404).json({
      error: `No existe el agente '${req.params.id}'`,
      available: getAgents().map((a) => a.id),
    });
  }
  if (agent.enabled === false) {
    return res.status(409).json({ error: `El agente '${agent.id}' está desactivado en el panel` });
  }

  const { prompt, temperature, max_tokens, task_label, source, step_id } = req.body;
  if (!prompt) return res.status(400).json({ error: "Falta 'prompt' en el body" });
  const tooLong = promptTooLong(prompt);
  if (tooLong) return res.status(413).json({ error: tooLong });

  try {
    const result = await runAgent({
      agent,
      prompt,
      source: source || "claude-code",
      meta: { task_label: task_label || null, step_id: step_id || null },
      overrides: { temperature, max_tokens },
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---- Delegación con varios agentes a la vez (fan-out) ----
app.post("/delegate", async (req, res) => {
  const { tasks } = req.body; // [{agent, prompt, task_label}]
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: "Envía 'tasks': [{agent, prompt, task_label}]" });
  }

  if (tasks.length > MAX_BATCH) {
    return res.status(400).json({ error: `Máximo ${MAX_BATCH} tareas por lote` });
  }
  const tooLong = tasks.map((t) => promptTooLong(t.prompt)).find(Boolean);
  if (tooLong) return res.status(413).json({ error: tooLong });

  // Se aceptan todas: la cola las sirve de a max_parallel, así que el Mac nunca
  // ve más peticiones de las que aguanta aunque el lote sea grande.

  const results = await Promise.allSettled(
    tasks.map((t) => {
      const agent = findAgent(t.agent);
      if (!agent) return Promise.reject(new Error(`Agente desconocido: ${t.agent}`));
      return runAgent({
        agent,
        prompt: t.prompt,
        source: "claude-code",
        meta: { task_label: t.task_label || null, step_id: t.step_id || null },
      }).then((r) => ({ agent: t.agent, ...r }));
    })
  );

  res.json({
    results: results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { agent: tasks[i].agent, error: String(r.reason?.message || r.reason) }
    ),
  });
});

// ---- Tokens que lleva gastados Claude Code ----
app.get("/api/claude-usage", (req, res) => {
  if (req.query.refresh) usageTracker.tick();
  res.json(usageTracker.snapshot());
});

// ---- Estado de LM Studio ----
app.get("/api/status", async (req, res) => {
  try {
    // /v1/models lista todo lo DESCARGADO, cargado o no: con él, un modelo que
    // nadie cargó parece disponible y las delegaciones fallan una a una. La API
    // propia de LM Studio sí dice el estado de cada uno; si no existe (versión
    // vieja), se cae a /v1/models y se da por cargado lo que liste.
    let models = [];
    const nativa = await fetch(`${config.lmstudio_url}/api/v0/models`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (nativa?.ok) {
      const data = await nativa.json();
      models = (data.data || []).filter((m) => m.state === "loaded" && m.type !== "embeddings").map((m) => m.id);
    } else {
      const r = await fetch(`${config.lmstudio_url}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = await r.json();
      models = (data.data || []).map((m) => m.id);
    }
    // Con un modelo por agente ya no basta con mirar config.model: falta cualquiera
    // de los que un agente activo tenga fijado y el panel debe decir cuál.
    const needed = [...new Set([config.model, ...getAgents().filter((a) => a.enabled !== false).map((a) => a.model)].filter(Boolean))];
    const missing = needed.filter((m) => !models.includes(m));
    const warning = !models.length
      ? "LM Studio responde pero no tiene ningún modelo cargado"
      : missing.length
      ? `Sin cargar: ${missing.join(", ")}. Cargados: ${models.join(", ")}`
      : null;
    res.json({ reachable: true, models, model_loaded: models.length > 0, warning, queue: queueState(), config });
  } catch (err) {
    res.json({ reachable: false, error: String(err.message || err), config });
  }
});

// ---- CRUD de agentes ----
app.get("/api/agents", (req, res) => res.json(getAgents()));

app.post("/api/agents", (req, res) => {
  agentsFile.agents = req.body;
  saveJSON(AGENTS_PATH, agentsFile);
  broadcast("agents:updated", agentsFile.agents);
  res.json(agentsFile.agents);
});

app.post("/api/agents/new", (req, res) => {
  const id = (req.body.id || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!id) return res.status(400).json({ error: "Id inválido" });
  if (findAgent(id)) return res.status(409).json({ error: "Ya existe un agente con ese id" });

  const palette = ["#6d8dff", "#f0a868", "#4ade80", "#c084fc", "#38bdf8", "#fb7185"];
  agentsFile.agents.push({
    id,
    name: req.body.name || id,
    emoji: req.body.emoji || "🤖",
    color: palette[agentsFile.agents.length % palette.length],
    use_when: req.body.use_when || "",
    system_prompt: req.body.system_prompt || "Eres un agente asistente.",
    temperature: 0.3,
    max_tokens: 1200,
    model: req.body.model || "",
    enabled: true,
  });
  saveJSON(AGENTS_PATH, agentsFile);
  broadcast("agents:updated", agentsFile.agents);
  res.json(agentsFile.agents);
});

app.delete("/api/agents/:id", (req, res) => {
  agentsFile.agents = agentsFile.agents.filter((a) => a.id !== req.params.id);
  saveJSON(AGENTS_PATH, agentsFile);
  broadcast("agents:updated", agentsFile.agents);
  res.json(agentsFile.agents);
});

// ---- Planes ----
// Claude Code registra aquí el plan YA APROBADO por el usuario en Plan Mode.
app.post("/api/plan", (req, res) => {
  const { title, goal, steps, project } = req.body;
  if (!title || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: "Envía 'title' y 'steps': [{description, agent}]" });
  }

  // 'project' es opcional: la ruta del repo. Si existe, el plan se asocia a esa
  // carpeta y se añade a los proyectos recientes.
  const projectDir = resolveDir(project);
  const validProject = projectDir && isDirectory(projectDir) ? projectDir : null;
  if (validProject) touchProject(validProject);

  currentPlan = {
    id: crypto.randomUUID(),
    title,
    goal: goal || "",
    project: validProject,
    createdAt: new Date().toISOString(),
    // seq numera las tarjetas: sigue subiendo cuando se añaden a mano
    seq: steps.length,
    steps: steps.map((s, i) => ({
      id: `step-${i + 1}`,
      order: i + 1,
      sort: i + 1,
      description: s.description,
      agent: s.agent || null, // null = lo hace Claude Code directamente
      column: "todo",
      status: "todo",
      manual: false, // las tarjetas manuales las escribe el usuario en el panel
      error: false,
      note: null,
      runId: null,
      durationMs: null,
    })),
  };

  savePlan();
  broadcast("plan:new", currentPlan);
  res.json(currentPlan);
});

app.get("/api/plan", (req, res) => res.json(currentPlan || null));

// Marcar un paso que hizo Claude Code directamente (sin agente local)
app.post("/api/plan/step/:stepId", (req, res) => {
  if (!currentPlan) return res.status(404).json({ error: "No hay plan activo" });
  const { status, column, note } = req.body;
  const step = currentPlan.steps.find((s) => s.id === req.params.stepId);
  if (!step) return res.status(404).json({ error: "Paso no encontrado" });

  // 'status' es el vocabulario de siempre (pending/running/done/error) y se
  // traduce; 'column' es directo. Un paso marcado 'error' no cambia de columna:
  // se queda donde está con la marca roja.
  if (status === "error") step.error = true;
  else if (status || column) {
    step.error = false;
    place(step, columnFor(column || status, step.column), 0);
  }
  if (note !== undefined) step.note = note;
  planChanged();
  res.json(step);
});

// Tarjeta escrita a mano en el panel: no viene de ningún paso del plan
app.post("/api/plan/tasks", (req, res) => {
  const description = String(req.body.description || "").trim();
  // Sin plan registrado el tablero sigue sirviendo: la primera tarjeta lo estrena
  if (!currentPlan) {
    currentPlan = {
      id: crypto.randomUUID(),
      title: "Tablero",
      goal: "",
      project: null,
      createdAt: new Date().toISOString(),
      seq: 0,
      steps: [],
    };
    broadcast("plan:new", currentPlan);
  }
  if (!description) return res.status(400).json({ error: "Falta 'description'" });
  if (currentPlan.steps.length >= MAX_STEPS) {
    return res.status(409).json({ error: `El tablero no admite más de ${MAX_STEPS} tarjetas` });
  }

  currentPlan.seq = (currentPlan.seq || currentPlan.steps.length) + 1;
  const step = {
    id: `step-${currentPlan.seq}`,
    order: currentPlan.seq,
    sort: 0,
    description: description.slice(0, 500),
    agent: findAgent(req.body.agent) ? req.body.agent : null,
    column: "todo",
    status: "todo",
    manual: true,
    error: false,
    note: null,
    runId: null,
    durationMs: null,
  };
  currentPlan.steps.push(step);
  place(step, columnFor(req.body.column), req.body.index);
  planChanged();
  res.json(step);
});

// Arrastrar y soltar: cambia de columna y de posición dentro de ella
app.post("/api/plan/step/:stepId/move", (req, res) => {
  if (!currentPlan) return res.status(404).json({ error: "No hay plan activo" });
  const step = currentPlan.steps.find((s) => s.id === req.params.stepId);
  if (!step) return res.status(404).json({ error: "Paso no encontrado" });
  if (!COLUMNS.includes(req.body.column)) {
    return res.status(400).json({ error: `'column' debe ser una de: ${COLUMNS.join(", ")}` });
  }

  // Mover una tarjeta a mano es dar por vista la marca de error
  if (["done", "approved"].includes(req.body.column)) step.error = false;
  place(step, req.body.column, req.body.index);
  planChanged();
  res.json(step);
});

app.delete("/api/plan/step/:stepId", (req, res) => {
  if (!currentPlan) return res.status(404).json({ error: "No hay plan activo" });
  const idx = currentPlan.steps.findIndex((s) => s.id === req.params.stepId);
  if (idx < 0) return res.status(404).json({ error: "Paso no encontrado" });
  const [step] = currentPlan.steps.splice(idx, 1);
  planChanged();
  res.json({ ok: true, removed: step.id });
});

app.delete("/api/plan", (req, res) => {
  currentPlan = null;
  savePlan();
  broadcast("plan:cleared", {});
  res.json({ ok: true });
});

// ---- Runs ----
app.get("/api/runs", (req, res) => res.json(runs));
app.get("/api/runs/:id", (req, res) => {
  const run = runs.find((r) => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Run no encontrado" });
  res.json(run);
});
// Aborta el stream (o saca de la cola) y deja el run como cancelado
app.delete("/api/runs/:id", (req, res) => {
  const entry = inFlight.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Ese run ya no está en curso" });
  entry.cancel(CANCELLED);
  res.json({ ok: true });
});
app.delete("/api/runs", (req, res) => {
  runs = [];
  broadcast("runs:cleared", {});
  res.json({ ok: true });
});

// ---- Prueba manual desde el panel ----
app.post("/api/test", async (req, res) => {
  const agent = findAgent(req.body.agentId);
  if (!agent) return res.status(400).json({ error: "Agente desconocido" });
  const tooLong = promptTooLong(req.body.prompt);
  if (tooLong) return res.status(413).json({ error: tooLong });
  try {
    const result = await runAgent({
      agent,
      prompt: req.body.prompt,
      source: "panel",
      meta: { task_label: "prueba manual" },
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---- Proyectos recientes ----
app.get("/api/projects", (req, res) => res.json(listProjects()));

app.post("/api/projects", (req, res) => {
  const dir = resolveDir(req.body.path);
  if (!dir || !isDirectory(dir)) return res.status(400).json({ error: "La carpeta no existe" });
  touchProject(dir);
  res.json(projectView(projects.find((p) => p.path === dir)));
});

// Quita la carpeta de la lista (no toca el disco) y cierra su sesión si la tiene
app.delete("/api/projects", (req, res) => {
  const dir = resolveDir(req.body.path);
  projects = projects.filter((p) => p.path !== dir);
  saveJSON(PROJECTS_PATH, projects);
  [...sessions.values()].filter((s) => s.cwd === dir).forEach(killSession);
  broadcastSessions();
  broadcastProjects();
  res.json(listProjects());
});

// ---- Mapa de código ----
// Análisis estático de una carpeta: qué funciones hay, dónde y quién las llama.
// Se cachea en memoria (como los runs): recorrer un repo grande cuesta segundos
// y el grafo no cambia mientras no se edite el código.
const GRAPH_CACHE_MS = 5 * 60 * 1000;
const GRAPH_CACHE_MAX = 4; // un grafo grande pesa megas: no guardes muchos
const graphCache = new Map();

app.get("/api/graph", (req, res) => {
  const dir = resolveDir(req.query.path);
  if (!dir) return res.status(400).json({ error: "Falta el parámetro path" });
  if (!isDirectory(dir)) return res.status(404).json({ error: "La carpeta no existe" });

  const cached = graphCache.get(dir);
  const fresh = cached && Date.now() - cached.at < GRAPH_CACHE_MS;
  if (fresh && req.query.refresh !== "1") return res.json({ ...cached.graph, cached: true });

  try {
    const graph = buildGraph(dir);
    graphCache.delete(dir);
    graphCache.set(dir, { at: Date.now(), graph });
    // Map conserva el orden de inserción: el primero es el más viejo
    while (graphCache.size > GRAPH_CACHE_MAX) graphCache.delete(graphCache.keys().next().value);
    touchProject(dir);
    res.json({ ...graph, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Archivos (pestaña Editor) ----
// Solo se ve y se escribe dentro de las carpetas que ya están en Proyectos:
// la contención la resuelve safepath.js, aquí solo se traduce a códigos HTTP.
const FORBIDDEN = { error: "Esa ruta no está dentro de ningún proyecto abierto" };
const projectRoots = () => projects.map((p) => p.path);
const insideProject = (p, opts) => safepath.resolveInsideRoots(p, projectRoots(), opts);

app.get("/api/files/tree", (req, res) => {
  const dir = insideProject(req.query.path);
  if (!dir || !isDirectory(dir)) return res.status(403).json(FORBIDDEN);
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== ".DS_Store" && !safepath.SKIP_DIRS.has(e.name))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }))
      // Carpetas primero, y dentro de cada grupo por nombre, como en un editor
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "es") : a.dir ? -1 : 1));
    res.json({ path: dir, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/files/read", (req, res) => {
  const file = insideProject(req.query.path);
  if (!file) return res.status(403).json(FORBIDDEN);

  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return res.status(404).json({ error: "El archivo no existe" });
  }
  if (!st.isFile()) return res.status(400).json({ error: "No es un archivo" });
  if (st.size > safepath.MAX_FILE_BYTES) {
    return res.status(413).json({ error: "El archivo pasa de 2 MB: ábrelo en tu editor de siempre" });
  }

  const buf = fs.readFileSync(file);
  if (safepath.looksBinary(buf)) return res.status(415).json({ error: "Es un archivo binario" });
  res.json({ path: file, content: buf.toString("utf-8"), size: st.size, mtimeMs: st.mtimeMs });
});

app.post("/api/files/write", (req, res) => {
  const file = insideProject(req.body.path);
  if (!file) return res.status(403).json(FORBIDDEN);
  if (typeof req.body.content !== "string") return res.status(400).json({ error: "Falta 'content'" });
  if (Buffer.byteLength(req.body.content) > safepath.MAX_FILE_BYTES) {
    return res.status(413).json({ error: "El contenido pasa de 2 MB" });
  }
  if (isDirectory(file)) return res.status(400).json({ error: "Esa ruta es una carpeta" });

  try {
    fs.writeFileSync(file, req.body.content, "utf-8");
    const st = fs.statSync(file);
    res.json({ ok: true, path: file, size: st.size, mtimeMs: st.mtimeMs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fechas de modificación de los archivos abiertos: así el editor se entera de
// que Claude Code acaba de tocar uno y lo recarga.
app.post("/api/files/stat", (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths.slice(0, 50) : [];
  res.json(
    paths.map((p) => {
      const file = insideProject(p);
      if (!file) return { path: p, missing: true };
      try {
        return { path: p, mtimeMs: fs.statSync(file).mtimeMs };
      } catch (_) {
        return { path: p, missing: true };
      }
    })
  );
});

// ---- Terminal ----
app.get("/api/terminals", (req, res) => res.json([...sessions.values()].map(sessionView)));

// Abre (o reutiliza) la sesión de claude de una carpeta
app.post("/api/terminals", (req, res) => {
  const dir = resolveDir(req.body.path);
  if (!dir || !isDirectory(dir)) return res.status(400).json({ error: "La carpeta no existe" });

  const cols = clampSize(req.body.cols, 100);
  const rows = clampSize(req.body.rows, 30);
  let s = [...sessions.values()].find((x) => x.cwd === dir && !x.exited);
  if (!s) {
    // Una sesión terminada de la misma carpeta se reemplaza por la nueva
    [...sessions.values()].filter((x) => x.cwd === dir).forEach(killSession);
    try {
      s = startSession(dir, cols, rows);
    } catch (err) {
      return res.status(500).json({ error: `No se pudo abrir la terminal: ${err.message}` });
    }
  }
  touchProject(dir);
  res.json(sessionView(s));
});

// SSE: primero el scrollback, luego la salida en vivo
app.get("/api/terminals/:id/stream", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Sesión no encontrada" });

  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  writeSse(res, "buffer", s.buffer);
  if (s.exited) writeSse(res, "exit", { exitCode: s.exitCode });
  s.clients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch (_) {}
  }, 20000);
  req.on("close", () => {
    clearInterval(keepAlive);
    s.clients.delete(res);
  });
});

app.post("/api/terminals/:id/input", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || s.exited) return res.status(404).json({ error: "Sesión no disponible" });
  if (typeof req.body.data !== "string") return res.status(400).json({ error: "Falta 'data'" });
  s.proc.write(req.body.data);
  res.json({ ok: true });
});

app.post("/api/terminals/:id/resize", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || s.exited) return res.status(404).json({ error: "Sesión no disponible" });
  try {
    s.proc.resize(clampSize(req.body.cols, 100), clampSize(req.body.rows, 30));
  } catch (_) {}
  res.json({ ok: true });
});

app.delete("/api/terminals/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Sesión no encontrada" });
  killSession(s);
  broadcastSessions();
  broadcastProjects();
  res.json({ ok: true });
});

// ---- Config ----
app.get("/api/config", (req, res) => res.json(config));
app.post("/api/config", (req, res) => {
  config = { ...config, ...req.body };
  saveJSON(CONFIG_PATH, config);
  fillFreeSlots();
  res.json(config);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Claude Dispatch → http://localhost:${PORT}\n`);
  console.log(`  Manifest para Claude Code: GET http://localhost:${PORT}/api/manifest`);
  console.log(`  Invocar agente:            POST http://localhost:${PORT}/agent/{id}\n`);
});
