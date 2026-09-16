const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const pty = require("node-pty");

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

const loadJSON = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));
const saveJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2));

let config = loadJSON(CONFIG_PATH);
let agentsFile = loadJSON(AGENTS_PATH);

const getAgents = () => agentsFile.agents;
const findAgent = (id) => getAgents().find((a) => a.id === id);

// ============ Estado en vivo ============
// runs: historial + estado actual de cada delegación
let runs = [];
// currentPlan: el plan aprobado que Claude Code está ejecutando
let currentPlan = null;
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

function createRun({ agentId, prompt, source, meta }) {
  const run = {
    id: crypto.randomUUID(),
    agentId,
    prompt,
    source: source || "desconocido",
    meta: meta || {},
    stepId: meta?.step_id || null,
    status: "running",
    response: "",
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    tokensApprox: null,
  };
  runs.unshift(run);
  if (runs.length > (config.max_runs_kept || 300)) runs.length = config.max_runs_kept;

  // Si el run pertenece a un paso del plan, marcar ese paso como en curso
  if (run.stepId) setStepStatus(run.stepId, "running", { runId: run.id });

  broadcast("run:start", run);
  return run;
}

function updateRun(run, patch) {
  Object.assign(run, patch);
  if (run.stepId && (run.status === "done" || run.status === "error")) {
    setStepStatus(run.stepId, run.status === "done" ? "done" : "error", {
      runId: run.id,
      durationMs: run.durationMs,
    });
  }
  broadcast("run:update", run);
}

function setStepStatus(stepId, status, extra = {}) {
  if (!currentPlan) return;
  const step = currentPlan.steps.find((s) => s.id === stepId);
  if (!step) return;
  Object.assign(step, { status, ...extra });
  broadcast("plan:update", currentPlan);
}

// ============ Proyectos recientes ============
// Carpetas abiertas desde el panel o registradas por Claude Code al mandar un plan.
// Es lo único de esta sección que va a disco; las sesiones de terminal viven en memoria.
const MAX_PROJECTS = 30;
let projects = fs.existsSync(PROJECTS_PATH) ? loadJSON(PROJECTS_PATH) : [];

function resolveDir(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  const expanded = p.trim().replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(expanded);
}

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

// ============ Sesiones de terminal (Claude Code dentro del panel) ============
// Una sesión = un pty con la shell de login del usuario que arranca `claude` en la
// carpeta del proyecto. Al salir de claude queda la shell abierta.
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
  // Las instrucciones del orquestador viajan por variable de entorno: así no hay
  // que escapar comillas ni saltos de línea dentro del comando de la shell
  env.DISPATCH_INSTRUCTIONS = buildInstructions(cwd);

  // -l -i: carga el perfil del usuario, que es donde está el PATH hacia `claude`.
  // --append-system-prompt: sin esto claude solo ve los CLAUDE.md de la carpeta
  // y no sabe que tiene agentes locales a su disposición.
  const command =
    'claude --append-system-prompt "$DISPATCH_INSTRUCTIONS"; unset DISPATCH_INSTRUCTIONS; exec "$SHELL" -l -i';
  const proc = pty.spawn(shell, ["-l", "-i", "-c", command], {
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

  // Agrupamos la salida en ráfagas de ~16 ms: claude redibuja mucho y un evento
  // SSE por chunk satura la conexión
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

// Que ninguna sesión sobreviva al orquestador (launcher.sh stop manda SIGTERM)
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    sessions.forEach(killSession);
    process.exit(0);
  });
}

const clampSize = (n, fallback) => {
  const v = parseInt(n, 10);
  return Number.isFinite(v) && v >= 2 && v <= 1000 ? v : fallback;
};

// ============ Llamada a LM Studio (con streaming) ============
async function runAgent({ agent, prompt, source, meta, overrides = {} }) {
  const run = createRun({ agentId: agent.id, prompt, source, meta });
  const started = Date.now();

  const body = {
    model: overrides.model || config.model,
    messages: [
      { role: "system", content: agent.system_prompt },
      { role: "user", content: prompt },
    ],
    temperature: overrides.temperature ?? agent.temperature ?? 0.3,
    max_tokens: overrides.max_tokens ?? agent.max_tokens ?? 1024,
    stream: true,
  };

  try {
    const res = await fetch(`${config.lmstudio_url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    let lastFlush = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            // throttle: emitimos al panel cada ~120ms para no saturar
            const now = Date.now();
            if (now - lastFlush > 120) {
              lastFlush = now;
              broadcast("run:token", { id: run.id, partial: full });
            }
          }
        } catch (_) {}
      }
    }

    const durationMs = Date.now() - started;
    updateRun(run, {
      status: "done",
      response: full,
      finishedAt: new Date().toISOString(),
      durationMs,
      tokensApprox: Math.round(full.length / 4),
    });

    return { content: full, durationMs, runId: run.id };
  } catch (err) {
    const durationMs = Date.now() - started;
    updateRun(run, {
      status: "error",
      error: String(err.message || err),
      finishedAt: new Date().toISOString(),
      durationMs,
    });
    throw err;
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
const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
app.use("/vendor/xterm", express.static(path.join(pkgDir("@xterm/xterm"), "lib")));
app.use("/vendor/xterm", express.static(path.join(pkgDir("@xterm/xterm"), "css")));
app.use("/vendor/xterm", express.static(path.join(pkgDir("@xterm/addon-fit"), "lib")));

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
  const list = enabled.map((a) => `- ${a.id} (${a.name}): ${a.use_when}`).join("\n");

  // Solo se nombran los agentes activos: si uno está apagado, Claude no debe contar con él
  const defaultRules = [
    has("tester") &&
      "- tester: si escribiste o cambiaste lógica, pídele los tests unitarios de esa\n  lógica. Revísalos y ajústalos tú antes de integrarlos.",
    has("reviewer") &&
      "- reviewer: antes de dar la tarea por terminada, mándale el diff (o las partes\n  clave si es muy grande). Valora sus observaciones; no todas serán correctas.",
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
(un modelo de 9B en LM Studio) a tu disposición para lo que necesites. No leen
archivos ni recuerdan nada: todo el contexto se lo pasas tú en el prompt.
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

3) EJECUCIÓN
   Paso tuyo:
     curl -s -X POST http://localhost:${port}/api/plan/step/step-1 \\
       -H "Content-Type: application/json" -d '{"status":"done"}'

   Paso delegado (incluye el contexto en el prompt):
     curl -s -X POST http://localhost:${port}/agent/{id} \\
       -H "Content-Type: application/json" \\
       -d '{"prompt":"Contexto:\\n<código>\\n\\nTarea:\\n<qué>",
            "task_label":"etiqueta","step_id":"step-2"}'

   En paralelo (máx ${config.max_parallel || 4}):
     curl -s -X POST http://localhost:${port}/delegate \\
       -H "Content-Type: application/json" \\
       -d '{"tasks":[{"agent":"tester","prompt":"...","step_id":"step-3"}]}'

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

  const limit = config.max_parallel || 4;
  if (tasks.length > limit) {
    return res.status(400).json({
      error: `Máximo ${limit} tareas en paralelo (configurable en data/config.json)`,
    });
  }

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

// ---- Estado de LM Studio ----
app.get("/api/status", async (req, res) => {
  try {
    const r = await fetch(`${config.lmstudio_url}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const data = await r.json();
    res.json({ reachable: true, models: (data.data || []).map((m) => m.id), config });
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
    steps: steps.map((s, i) => ({
      id: `step-${i + 1}`,
      order: i + 1,
      description: s.description,
      agent: s.agent || null, // null = lo hace Claude Code directamente
      status: "pending",
      runId: null,
      durationMs: null,
    })),
  };

  broadcast("plan:new", currentPlan);
  res.json(currentPlan);
});

app.get("/api/plan", (req, res) => res.json(currentPlan || null));

// Marcar un paso que hizo Claude Code directamente (sin agente local)
app.post("/api/plan/step/:stepId", (req, res) => {
  if (!currentPlan) return res.status(404).json({ error: "No hay plan activo" });
  const { status, note } = req.body;
  const step = currentPlan.steps.find((s) => s.id === req.params.stepId);
  if (!step) return res.status(404).json({ error: "Paso no encontrado" });

  step.status = status || step.status;
  if (note) step.note = note;
  broadcast("plan:update", currentPlan);
  res.json(step);
});

app.delete("/api/plan", (req, res) => {
  currentPlan = null;
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
app.delete("/api/runs", (req, res) => {
  runs = [];
  broadcast("runs:cleared", {});
  res.json({ ok: true });
});

// ---- Prueba manual desde el panel ----
app.post("/api/test", async (req, res) => {
  const agent = findAgent(req.body.agentId);
  if (!agent) return res.status(400).json({ error: "Agente desconocido" });
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
  res.json(config);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Claude Dispatch → http://localhost:${PORT}\n`);
  console.log(`  Manifest para Claude Code: GET http://localhost:${PORT}/api/manifest`);
  console.log(`  Invocar agente:            POST http://localhost:${PORT}/agent/{id}\n`);
});
