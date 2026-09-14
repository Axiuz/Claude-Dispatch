const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let agents = [];
let runs = [];
let config = {};
let currentPlan = null;
const agentState = {}; // id -> {status, taskLabel, lastDuration, count}

// ================= Render: plan =================
function renderPlan() {
  const wrap = $("#planWrap");
  if (!currentPlan) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";

  $("#planTitle").textContent = currentPlan.title;
  $("#planGoal").textContent = currentPlan.goal || "";

  const total = currentPlan.steps.length;
  const done = currentPlan.steps.filter((s) => s.status === "done").length;
  $("#planBar").style.width = `${(done / total) * 100}%`;

  const cont = $("#planSteps");
  cont.innerHTML = "";
  currentPlan.steps.forEach((step) => {
    const agent = agents.find((a) => a.id === step.agent);
    const div = document.createElement("div");
    div.className = `plan-step ${step.status}`;

    const mark = step.status === "done" ? "✓" : step.status === "error" ? "!" : step.order;

    div.innerHTML = `
      <span class="step-num">${mark}</span>
      <div class="step-body">
        <div class="step-desc">${escapeHtml(step.description)}</div>
        <div class="step-meta">
          <span class="who ${step.agent ? "" : "claude"}">${
            step.agent ? `${agent?.emoji || "🤖"} ${agent?.name || step.agent}` : "◈ Claude Code"
          }</span>
          ${step.durationMs ? `<span>${(step.durationMs / 1000).toFixed(1)}s</span>` : ""}
          ${step.note ? `<span>${escapeHtml(step.note)}</span>` : ""}
        </div>
      </div>
    `;

    if (step.runId) {
      div.style.cursor = "pointer";
      div.addEventListener("click", () => openRunModal(step.runId));
    }
    cont.appendChild(div);
  });
}

// ================= Tabs =================
$$(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab-btn").forEach((b) => b.classList.remove("active"));
    $$(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
});

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

  es.addEventListener("run:token", (e) => {
    const { id, partial } = JSON.parse(e.data);
    const run = runs.find((r) => r.id === id);
    if (run) {
      run.response = partial;
      updateRunStream(id, partial);
    }
  });

  es.addEventListener("run:update", (e) => {
    const updated = JSON.parse(e.data);
    const idx = runs.findIndex((r) => r.id === updated.id);
    if (idx >= 0) runs[idx] = updated;
    else runs.unshift(updated);

    const st = agentState[updated.agentId] || {};
    setAgentState(updated.agentId, {
      status: updated.status === "error" ? "error" : "idle",
      taskLabel: st.taskLabel,
      lastDuration: updated.durationMs,
      count: (st.count || 0) + (updated.status === "done" ? 1 : 0),
    });
    renderAgents();
    renderTimeline();
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
    renderAgentSelect();
  });

  es.addEventListener("runs:cleared", () => {
    runs = [];
    renderTimeline();
  });

  es.onerror = () => {
    // EventSource reintenta solo; no hacemos nada
  };
}

function setAgentState(id, patch) {
  agentState[id] = { ...(agentState[id] || {}), ...patch };
}

// ================= Render: tarjetas de agentes =================
function renderAgents() {
  const grid = $("#agentGrid");
  grid.innerHTML = "";

  let working = 0;
  agents.forEach((a) => {
    const st = agentState[a.id] || {};
    if (st.status === "working") working++;

    const card = document.createElement("div");
    card.className = "agent-card";
    if (a.enabled === false) card.classList.add("disabled");
    if (st.status === "working") card.classList.add("working");
    if (st.status === "error") card.classList.add("error-state");

    const stateLabel =
      a.enabled === false ? "off" : st.status === "working" ? "trabajando" : st.status === "error" ? "error" : "libre";

    card.innerHTML = `
      <div class="head">
        <span class="emoji">${a.emoji || "🤖"}</span>
        <span class="name">${escapeHtml(a.name)}</span>
        <span class="state">${stateLabel}</span>
      </div>
      <div class="task">${st.taskLabel ? escapeHtml(st.taskLabel) : '<span style="opacity:.5">sin tarea asignada</span>'}</div>
      <div class="stats">
        <span>${st.count || 0} tareas</span>
        ${st.lastDuration ? `<span>último: ${(st.lastDuration / 1000).toFixed(1)}s</span>` : ""}
      </div>
    `;
    grid.appendChild(card);
  });

  $("#activeCount").textContent = working > 0 ? `${working} trabajando` : "todos libres";
}

// ================= Render: timeline =================
function renderTimeline() {
  const tl = $("#timeline");
  if (runs.length === 0) {
    tl.innerHTML = '<p class="muted empty">Sin actividad todavía. Las delegaciones de Claude Code aparecerán aquí en vivo.</p>';
    return;
  }

  tl.innerHTML = "";
  runs.slice(0, 40).forEach((run) => {
    const agent = agents.find((a) => a.id === run.agentId);
    const div = document.createElement("div");
    div.className = `run-item ${run.status}`;
    div.dataset.runId = run.id;

    const time = new Date(run.startedAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    div.innerHTML = `
      <div class="run-head">
        <span>${agent?.emoji || "🤖"}</span>
        <span class="run-agent">${escapeHtml(agent?.name || run.agentId)}</span>
        <span class="run-badge source">${escapeHtml(run.source)}</span>
        ${run.meta?.task_label ? `<span class="run-badge">${escapeHtml(run.meta.task_label)}</span>` : ""}
        <span class="run-time">${time}${run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ""}</span>
      </div>
      <div class="run-prompt"><strong>Tarea:</strong> ${escapeHtml(truncate(run.prompt, 160))}</div>
      ${
        run.status === "error"
          ? `<div class="run-stream" style="color:var(--red)">${escapeHtml(run.error || "")}</div>`
          : run.response
          ? `<div class="run-stream fading" data-stream="${run.id}">${escapeHtml(truncate(run.response, 600))}${run.status === "running" ? '<span class="cursor">&nbsp;</span>' : ""}</div>`
          : run.status === "running"
          ? `<div class="run-stream" data-stream="${run.id}"><span class="cursor">&nbsp;</span></div>`
          : ""
      }
    `;

    div.addEventListener("click", () => openRunModal(run.id));
    tl.appendChild(div);
  });
}

function updateRunStream(id, partial) {
  const el = document.querySelector(`[data-stream="${id}"]`);
  if (el) {
    el.classList.add("fading");
    el.innerHTML = escapeHtml(truncate(partial, 600)) + '<span class="cursor">&nbsp;</span>';
  } else {
    renderTimeline();
  }
}

// ================= Modal de detalle =================
function openRunModal(id) {
  const run = runs.find((r) => r.id === id);
  if (!run) return;
  const agent = agents.find((a) => a.id === run.agentId);

  $("#modalTitle").textContent = `${agent?.emoji || "🤖"} ${agent?.name || run.agentId}`;
  $("#modalBody").innerHTML = `
    <div class="modal-section">
      <h4>Metadatos</h4>
      <p class="muted">
        Origen: ${escapeHtml(run.source)} · Estado: ${run.status}
        ${run.durationMs ? ` · Duración: ${(run.durationMs / 1000).toFixed(2)}s` : ""}
        ${run.tokensApprox ? ` · ~${run.tokensApprox} tokens` : ""}
      </p>
    </div>
    <div class="modal-section">
      <h4>Prompt enviado</h4>
      <pre class="output-box">${escapeHtml(run.prompt)}</pre>
    </div>
    <div class="modal-section">
      <h4>${run.status === "error" ? "Error" : "Respuesta"}</h4>
      <pre class="output-box">${escapeHtml(run.error || run.response || "—")}</pre>
    </div>
  `;
  $("#modalBackdrop").classList.add("open");
}

$("#closeModalBtn").addEventListener("click", () => $("#modalBackdrop").classList.remove("open"));
$("#modalBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "modalBackdrop") $("#modalBackdrop").classList.remove("open");
});

// ================= Editor de agentes =================
function renderAgentsEditor() {
  const c = $("#agentsEditor");
  c.innerHTML = "";
  agents.forEach((a) => {
    const block = document.createElement("div");
    block.className = "agent-block";
    block.innerHTML = `
      <div class="block-head">
        <span style="font-size:17px">${a.emoji || "🤖"}</span>
        <input class="name-input" data-id="${a.id}" data-field="name" value="${escapeAttr(a.name)}" />
        <span class="id-tag">/agent/${a.id}</span>
        <label class="toggle"><input type="checkbox" data-id="${a.id}" data-field="enabled" ${a.enabled !== false ? "checked" : ""}/> activo</label>
        <button class="btn danger small" data-delete="${a.id}">Eliminar</button>
      </div>

      <label>Cuándo usarlo (esto lee Claude Code para elegir)</label>
      <textarea rows="2" data-id="${a.id}" data-field="use_when">${escapeHtml(a.use_when || "")}</textarea>

      <label>System prompt</label>
      <textarea rows="6" data-id="${a.id}" data-field="system_prompt">${escapeHtml(a.system_prompt || "")}</textarea>

      <div class="mini-row">
        <div>
          <label>Temperatura</label>
          <input type="number" step="0.1" min="0" max="1" data-id="${a.id}" data-field="temperature" value="${a.temperature ?? 0.3}" />
        </div>
        <div>
          <label>Max tokens</label>
          <input type="number" step="50" min="100" data-id="${a.id}" data-field="max_tokens" value="${a.max_tokens ?? 1200}" />
        </div>
        <div>
          <label>Emoji</label>
          <input type="text" maxlength="2" data-id="${a.id}" data-field="emoji" value="${escapeAttr(a.emoji || "🤖")}" />
        </div>
      </div>
    `;
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

  await fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updated),
  });
  await loadAgents();
  flash("#agentsSaved", "Guardado ✓");
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
function renderAgentSelect() {
  const sel = $("#consoleAgent");
  sel.innerHTML = "";
  agents
    .filter((a) => a.enabled !== false)
    .forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = `${a.emoji || "🤖"} ${a.name}`;
      sel.appendChild(opt);
    });
}

$("#sendConsoleBtn").addEventListener("click", async () => {
  const agentId = $("#consoleAgent").value;
  const prompt = $("#consolePrompt").value.trim();
  if (!prompt) return;

  $("#consoleStatus").textContent = "Ejecutando…";
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
    $("#consoleStatus").textContent = `Listo en ${(data.durationMs / 1000).toFixed(1)}s`;
  } catch (err) {
    $("#consoleOutput").textContent = "Error: " + err.message;
    $("#consoleStatus").textContent = "";
  }
});

// ================= Estado / Config =================
async function refreshStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    config = data.config;
    if (data.reachable) {
      $("#statusDot").className = "dot ok";
      $("#statusText").textContent = `${data.config.model} · en línea`;
    } else {
      $("#statusDot").className = "dot bad";
      $("#statusText").textContent = "LM Studio no responde";
    }
  } catch {
    $("#statusDot").className = "dot bad";
    $("#statusText").textContent = "sin conexión";
  }
}

async function loadConfig() {
  const res = await fetch("/api/config");
  config = await res.json();
  $("#cfgLmUrl").value = config.lmstudio_url;
  $("#cfgModel").value = config.model;
  $("#cfgParallel").value = config.max_parallel;
  renderInstructions();
}

$("#saveConfigBtn").addEventListener("click", async () => {
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lmstudio_url: $("#cfgLmUrl").value.trim(),
      model: $("#cfgModel").value.trim(),
      max_parallel: parseInt($("#cfgParallel").value, 10),
    }),
  });
  await loadConfig();
  flash("#configSaved", "Guardado ✓");
  refreshStatus();
});

// ================= Instrucciones para Claude Code =================
function renderInstructions() {
  const port = config.app_port || 3131;
  const list = agents
    .filter((a) => a.enabled !== false)
    .map((a) => `- ${a.id} (${a.name}): ${a.use_when}`)
    .join("\n");

  const text = `# Flujo con agentes de IA locales

Eres el orquestador: tú lees mis archivos y tocas mi código. Los agentes locales
no leen archivos ni recuerdan nada — todo el contexto se lo pasas tú en el prompt.

## Agentes disponibles
${list}

## Ciclo de trabajo

1) PLAN — Entra en plan mode, lee lo necesario, arma el plan decidiendo qué paso
   hace cada quien, y preséntamelo. No ejecutes hasta que yo apruebe.

2) REGISTRO — Cuando apruebe, registra el plan en mi panel:
   curl -s -X POST http://localhost:${port}/api/plan \\
     -H "Content-Type: application/json" \\
     -d '{"title":"...","goal":"...","steps":[
           {"description":"Leer X","agent":null},
           {"description":"Generar Y","agent":"coder"}
         ]}'
   ("agent": null = lo haces tú)

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

4) REVISIÓN — Revisa cada respuesta antes de integrarla. Si viene mal, corrígela
   tú; no reenvíes la misma tarea al agente. Al terminar, repórtame qué cambió
   y qué dudas tienes. Cierra con: curl -s -X DELETE http://localhost:${port}/api/plan

## Reglas
- Verifica antes de empezar: curl -s http://localhost:${port}/api/status
  Si "reachable" es false, avísame en vez de continuar.
- Pega el código relevante en el prompt del agente; no describas el archivo.
- Incluye SIEMPRE "task_label" y "step_id" — es lo que veo en mi panel.
- NO delegues: arquitectura, cambios multi-archivo, lógica de negocio,
  integraciones externas (AWS/PayPal/Amplify), ni nada de seguridad/auth.
- Ante la duda, hazlo tú.`;

  $("#claudeInstructions").textContent = text;
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

// ================= Utilidades =================
function truncate(s, n) {
  s = s || "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}
function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
function flash(sel, msg) {
  $(sel).textContent = msg;
  setTimeout(() => ($(sel).textContent = ""), 2000);
}

// ================= Init =================
async function loadAgents() {
  agents = await (await fetch("/api/agents")).json();
  renderAgents();
  renderAgentsEditor();
  renderAgentSelect();
  renderInstructions();
}

$("#clearPlanBtn").addEventListener("click", async () => {
  await fetch("/api/plan", { method: "DELETE" });
  currentPlan = null;
  renderPlan();
});

async function init() {
  await loadAgents();
  await loadConfig();
  runs = await (await fetch("/api/runs")).json();
  currentPlan = await (await fetch("/api/plan")).json();
  renderPlan();
  renderTimeline();
  await refreshStatus();
  connectStream();
  setInterval(refreshStatus, 6000);
}

init();
