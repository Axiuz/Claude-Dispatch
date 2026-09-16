const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const AGENTS_PATH = path.join(DATA_DIR, "agents.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

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
app.use(express.static(path.join(__dirname, "public")));

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
      register: 'POST /api/plan  {"title": "...", "goal": "...", "steps": [{"description": "...", "agent": "coder"}]}',
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
  const { title, goal, steps } = req.body;
  if (!title || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: "Envía 'title' y 'steps': [{description, agent}]" });
  }

  currentPlan = {
    id: crypto.randomUUID(),
    title,
    goal: goal || "",
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
