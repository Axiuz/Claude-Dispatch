#!/usr/bin/env node
// Benchmark de modelos locales para el orquestador.
//
// Corre las mismas cuatro tareas (coder, tester, documenter, explainer) contra
// el modelo que tengas cargado en LM Studio, usando los system prompts reales
// de data/agents.json y su max_tokens real. Mide tiempo, velocidad y —lo que
// más nos importa— cuánto del presupuesto se va en razonar y si la
// respuesta llega vacía.
//
//   node dev/bench-modelos.js --list
//   node dev/bench-modelos.js --model qwen/qwen3-4b-2507 --label "Qwen3 4B" --no-think
//   node dev/bench-modelos.js --model google/gemma-3-4b --label "Gemma 3 4B"
//   node dev/bench-modelos.js --compare
//
// Cada corrida deja un JSON en bench-resultados/. --compare los lee todos y
// saca las tablas comparativas.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, "bench-resultados");

// ---------------------------------------------------------------- argumentos

function parseArgs(argv) {
  const args = { tasks: null, repeat: 1, warmup: true, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.model = argv[++i];
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--tasks") args.tasks = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--repeat") args.repeat = Number(argv[++i]) || 1;
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--max-tokens") args.maxTokens = Number(argv[++i]);
    else if (a === "--timeout") args.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === "--no-think") args.noThink = true;
    else if (a === "--no-warmup") args.warmup = false;
    else if (a === "--list") args.list = true;
    else if (a === "--compare") args.compare = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Opción desconocida: ${a}`);
  }
  return args;
}

const USAGE = `
Uso:
  node dev/bench-modelos.js --model <id> [--label <nombre>] [opciones]
  node dev/bench-modelos.js --compare [--out <dir>]
  node dev/bench-modelos.js --list

Opciones:
  --label <texto>    Nombre para las tablas (por defecto, el id del modelo)
  --no-think         Añade "/no_think" al final del prompt (Qwen3)
  --tasks a,b,c      Solo estas tareas (coder,tester,documenter,explainer)
  --repeat N         Repite cada tarea N veces y se queda con la mediana
  --max-tokens N     Ignora el max_tokens del agente y usa este
  --timeout S        Corta una tarea a los S segundos (por defecto 300)
  --no-warmup        Salta la llamada de calentamiento
  --url <url>        LM Studio (por defecto, el de data/config.json)
  --out <dir>        Dónde guardar/leer los JSON (por defecto bench-resultados/)
`.trim();

// --------------------------------------------------------------- las tareas

// Contexto real de este repo: lo que un agente recibiría de verdad.
const KANBAN_SNIPPET = `const COLUMNS = ["todo", "progress", "review", "done", "approved"];

function columnFor(status) {
  if (status === "running") return "progress";
  if (status === "done") return "review";
  if (status === "error") return "review";
  if (status === "cancelled") return "todo";
  return "todo";
}

function place(steps, stepId, column, index) {
  const step = steps.find((s) => s.id === stepId);
  if (!step) return steps;
  const rest = steps.filter((s) => s.id !== stepId);
  const target = rest.filter((s) => s.column === column);
  target.splice(Math.max(0, Math.min(index, target.length)), 0, step);
  step.column = column;
  step.manual = true;
  target.forEach((s, i) => (s.sort = i));
  return rest.concat([step]);
}`;

const TASKS = [
  {
    id: "coder",
    agent: "coder",
    // Volumen mecánico y autocontenido: el único caso en que delegamos código.
    prompt: `Contexto — el proyecto es Node.js, CommonJS, sin dependencias externas.
Los errores de validación se acumulan en un array de strings en español.
Este es el patrón que ya usamos para un campo:

function validarTitulo(valor, errores) {
  if (typeof valor !== "string" || !valor.trim()) {
    errores.push("El título es obligatorio");
  } else if (valor.trim().length > 120) {
    errores.push("El título no puede pasar de 120 caracteres");
  }
}

Tarea: escribe con exactamente ese patrón las funciones validarDescripcion
(string opcional, máximo 2000 caracteres), validarColumna (debe ser uno de
"todo", "progress", "review", "done", "approved"), validarAgente (string
opcional, slug en minúsculas con guiones), validarSort (entero >= 0) y
validarProyecto (ruta absoluta que empiece por "/").

Devuelve solo el código, sin explicación.`,
    checks: {
      "5 funciones": (t) => (t.match(/function\s+validar/g) || []).length >= 5,
      "errores.push": (t) => /errores\.push\(/.test(t),
      "solo código": (t) => proseRatio(t) < 0.3,
    },
  },
  {
    id: "tester",
    agent: "tester",
    prompt: `Contexto — módulo kanban.js de un proyecto Node.js, CommonJS. Los tests
se escriben con el runner nativo: const test = require("node:test") y
const assert = require("node:assert"). Exporta { COLUMNS, columnFor, place }.

${KANBAN_SNIPPET}

Tarea: escribe los tests unitarios de columnFor y place. Cubre al menos:
cada status conocido, un status desconocido, mover una tarjeta al final de una
columna, un index fuera de rango y un stepId que no existe.

Devuelve solo el archivo de tests.`,
    checks: {
      "node:test": (t) => /node:test|require\(["']test["']\)/.test(t),
      "assert": (t) => /assert\./.test(t),
      "≥5 casos": (t) => (t.match(/\btest\s*\(/g) || []).length >= 5,
    },
  },
  {
    id: "documenter",
    agent: "documenter",
    prompt: `Contexto — hechos de lo que se cambió esta semana en el orquestador:

- Antes /delegate rechazaba con 400 cualquier lote mayor que max_parallel.
- Ahora acepta lotes de hasta 12 tareas y una cola global las va sirviendo.
- takeSlot() da turno si hay menos de max_parallel runs corriendo; si no,
  devuelve un ticket y el run espera en estado "queued".
- freeSlot() no libera el turno: se lo pasa al primero de la cola.
- Al guardar la configuración, fillFreeSlots() hace entrar a los que esperan,
  así que subir max_parallel surte efecto sin reiniciar.
- Motivo: LM Studio sirve un modelo a la vez; mandarle varias peticiones juntas
  no las hace más rápidas, multiplica el KV cache y en 16 GB acaba en swap.

Tarea: redacta la entrada del CHANGELOG en español. Un párrafo de tres o cuatro
líneas explicando el porqué, y debajo una lista de cuatro viñetas con los
cambios concretos. Sin títulos, sin código.`,
    checks: {
      "4 viñetas": (t) => (t.match(/^\s*[-*•]\s+/gm) || []).length >= 4,
      "en español": (t) => spanishScore(t) > 0,
      "sin código": (t) => !/```/.test(t),
    },
  },
  {
    id: "explainer",
    agent: "explainer",
    prompt: `Contexto — este módulo es de un proyecto que no conozco:

${KANBAN_SNIPPET}

Tarea: explícame en español qué hace este módulo y cuál es la intención de
place(). Máximo ocho líneas, en prosa, sin repetir el código.`,
    checks: {
      "en español": (t) => spanishScore(t) > 0,
      "≤ 12 líneas": (t) => t.trim().split(/\n+/).length <= 12,
      "sin código": (t) => !/```/.test(t),
    },
  },
];

// ------------------------------------------------------------- heurísticas

const ES = ["de", "la", "que", "el", "en", "los", "se", "del", "las", "por", "con", "para", "una", "es", "su", "cuando", "esta"];
const EN = ["the", "of", "and", "to", "is", "in", "that", "it", "for", "with", "this", "are", "be"];

// Positivo = más español que inglés. Solo para detectar que el modelo no se
// nos fue al inglés en documenter/explainer.
function spanishScore(text) {
  const words = text.toLowerCase().match(/[a-záéíóúñü]+/g) || [];
  const count = (list) => words.filter((w) => list.includes(w)).length;
  return count(ES) - count(EN);
}

// Fracción de líneas fuera de bloques de código que parecen prosa. Sirve para
// ver si el modelo obedeció "devuelve solo el código".
function proseRatio(text) {
  const lines = text.split("\n");
  let inFence = false;
  let prose = 0;
  let total = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence || !line.trim()) continue;
    total++;
    if (!/[{};()=]|^\s*(\/\/|\*|#)/.test(line) && /\s/.test(line.trim())) prose++;
  }
  return total ? prose / total : 0;
}

function memorySnapshot() {
  try {
    const swap = execSync("sysctl -n vm.swapusage", { encoding: "utf8" }).trim();
    const vm = execSync("vm_stat", { encoding: "utf8" });
    const pageSize = Number((vm.match(/page size of (\d+)/) || [])[1] || 16384);
    const pages = (name) => Number((vm.match(new RegExp(name + ":\\s+(\\d+)")) || [])[1] || 0);
    const freeGb = ((pages("Pages free") + pages("Pages inactive")) * pageSize) / 1024 ** 3;
    return { swap, libre_gb: Number(freeGb.toFixed(2)) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- LM Studio

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function getAgent(id) {
  const data = loadJson(path.join(ROOT, "data", "agents.json"));
  const list = Array.isArray(data) ? data : data.agents || [];
  const agent = list.find((a) => a.id === id);
  if (!agent) throw new Error(`No encuentro el agente "${id}" en data/agents.json`);
  return agent;
}

async function listModels(url) {
  const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`LM Studio respondió ${res.status} en /v1/models`);
  const body = await res.json();
  return (body.data || []).map((m) => m.id);
}

// Una llamada en streaming. Separa reasoning_content de content, cronometra el
// primer token (que es lo que dispara el stall_timeout del orquestador) y
// devuelve el usage si LM Studio lo manda.
async function callModel({ url, model, system, prompt, maxTokens, temperature, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let ttft = null;
  let content = "";
  let reasoning = "";
  let finish = null;
  let usage = null;

  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta || {};
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (delta.content) content += delta.content;
        if (ttft === null && (delta.content || delta.reasoning_content)) ttft = Date.now() - started;
        if (json.choices?.[0]?.finish_reason) finish = json.choices[0].finish_reason;
      }
    }
    return { ok: true, ms: Date.now() - started, ttft, content, reasoning, finish, usage };
  } catch (err) {
    const timedOut = err.name === "AbortError" || err.name === "TimeoutError";
    return {
      ok: false,
      ms: Date.now() - started,
      ttft,
      content,
      reasoning,
      finish: timedOut ? "timeout" : "error",
      usage,
      error: timedOut ? `cortado a los ${Math.round(timeoutMs / 1000)} s` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- la corrida

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function summarize(result, task) {
  const content = result.content.trim();
  // <think> filtrado en el texto: el modelo razonó dentro del content.
  const leaked = /<think>/i.test(content);
  const body = leaked ? content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : content;
  const completionTokens = result.usage?.completion_tokens || Math.round((result.reasoning.length + content.length) / 4);
  const checks = {};
  if (body) for (const [name, fn] of Object.entries(task.checks)) checks[name] = !!fn(body);

  return {
    ms: result.ms,
    ttft_ms: result.ttft,
    tok_s: result.ms ? Number((completionTokens / (result.ms / 1000)).toFixed(1)) : 0,
    tokens: completionTokens,
    razonamiento_chars: result.reasoning.length,
    respuesta_chars: body.length,
    vacia: body.length === 0,
    think_filtrado: leaked,
    finish: result.finish,
    error: result.error || null,
    checks,
    checks_ok: Object.values(checks).filter(Boolean).length,
    checks_total: Object.keys(task.checks).length,
    muestra: body.slice(0, 400),
  };
}

async function runBench(args) {
  const config = loadJson(path.join(ROOT, "data", "config.json"));
  const url = args.url || config.lmstudio_url || "http://127.0.0.1:1234";
  const loaded = await listModels(url);
  if (!loaded.includes(args.model)) {
    throw new Error(`"${args.model}" no está cargado. Cargados: ${loaded.join(", ") || "ninguno"}`);
  }

  const tasks = TASKS.filter((t) => !args.tasks || args.tasks.includes(t.id));
  const label = args.label || args.model;
  const timeoutMs = args.timeoutMs || 300000;

  console.log(`\nModelo: ${label}  (${args.model})`);
  console.log(`LM Studio: ${url}${args.noThink ? "   ·   /no_think activado" : ""}`);
  const memBefore = memorySnapshot();
  if (memBefore) console.log(`RAM antes: ${memBefore.libre_gb} GB libres · swap${memBefore.swap.replace(/^vm\.swapusage:/, "")}`);
  console.log("");

  if (args.warmup) {
    process.stdout.write("calentando… ");
    const w = await callModel({
      url, model: args.model, system: "Responde en una palabra.",
      prompt: "Di: listo", maxTokens: 16, temperature: 0, timeoutMs: 60000,
    });
    console.log(w.ok ? `${(w.ms / 1000).toFixed(1)} s\n` : `falló (${w.error})\n`);
  }

  const results = [];
  for (const task of tasks) {
    const agent = getAgent(task.agent);
    const prompt = args.noThink ? `${task.prompt}\n\n/no_think` : task.prompt;
    const maxTokens = args.maxTokens || agent.max_tokens || 1500;
    const runs = [];

    for (let i = 0; i < args.repeat; i++) {
      process.stdout.write(`${task.id}${args.repeat > 1 ? ` (${i + 1}/${args.repeat})` : ""}… `);
      const raw = await callModel({
        url,
        model: args.model,
        system: agent.system_prompt,
        prompt,
        maxTokens,
        temperature: agent.temperature ?? 0.3,
        timeoutMs,
      });
      const summary = summarize(raw, task);
      runs.push(summary);
      console.log(
        `${(summary.ms / 1000).toFixed(1)} s · ${summary.tok_s} tok/s · ` +
        `razón ${summary.razonamiento_chars} · resp ${summary.respuesta_chars} · ` +
        `${summary.vacia ? "VACÍA" : `${summary.checks_ok}/${summary.checks_total} checks`}` +
        `${summary.finish === "length" ? " · sin terminar" : ""}${summary.error ? ` · ${summary.error}` : ""}`
      );
    }

    const mid = runs.find((r) => r.ms === median(runs.map((x) => x.ms))) || runs[0];
    results.push({ tarea: task.id, max_tokens: maxTokens, repeticiones: runs.length, ...mid });
  }

  const memAfter = memorySnapshot();
  const record = {
    label,
    model: args.model,
    no_think: !!args.noThink,
    fecha: new Date().toISOString(),
    url,
    memoria: { antes: memBefore, despues: memAfter },
    resultados: results,
  };

  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));

  const ok = results.filter((r) => !r.vacia && r.checks_ok === r.checks_total).length;
  const total = results.reduce((a, r) => a + r.ms, 0) / 1000;
  console.log(`\n${ok}/${results.length} tareas impecables · ${total.toFixed(1)} s en total`);
  if (memAfter) console.log(`RAM después: ${memAfter.libre_gb} GB libres · swap${memAfter.swap.replace(/^vm\.swapusage:/, "")}`);
  console.log(`Guardado en ${path.relative(process.cwd(), file)}`);
  return record;
}

// ------------------------------------------------------------ comparación

function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - s.length));
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => "| " + cells.map((c, i) => pad(c, widths[i])).join(" | ") + " |";
  return [line(headers), "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|", ...rows.map(line)].join("\n");
}

function compare(dir) {
  if (!fs.existsSync(dir)) throw new Error(`No existe ${dir}. Corre primero un benchmark.`);
  const records = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadJson(path.join(dir, f)))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (!records.length) throw new Error(`No hay resultados en ${dir}.`);

  console.log("\n## Resumen por modelo\n");
  console.log(
    table(
      ["Modelo", "Impecables", "Vacías", "Tiempo", "tok/s", "Razonamiento"],
      records.map((r) => {
        const rs = r.resultados;
        const ok = rs.filter((x) => !x.vacia && x.checks_ok === x.checks_total).length;
        const reason = rs.reduce((a, x) => a + x.razonamiento_chars, 0);
        return [
          r.label + (r.no_think ? " /no_think" : ""),
          `${ok}/${rs.length}`,
          String(rs.filter((x) => x.vacia).length),
          `${(rs.reduce((a, x) => a + x.ms, 0) / 1000).toFixed(0)} s`,
          String(median(rs.map((x) => x.tok_s))),
          reason ? `${reason} chars` : "0",
        ];
      })
    )
  );

  for (const task of TASKS) {
    const rows = records
      .filter((r) => r.resultados.some((x) => x.tarea === task.id))
      .map((r) => {
        const x = r.resultados.find((y) => y.tarea === task.id);
        return [
          r.label + (r.no_think ? " /no_think" : ""),
          `${(x.ms / 1000).toFixed(1)} s`,
          x.ttft_ms ? `${(x.ttft_ms / 1000).toFixed(1)} s` : "—",
          String(x.tok_s),
          String(x.razonamiento_chars),
          x.vacia ? "VACÍA" : String(x.respuesta_chars),
          `${x.checks_ok}/${x.checks_total}`,
          x.finish || "—",
        ];
      });
    if (!rows.length) continue;
    console.log(`\n## ${task.id}\n`);
    console.log(table(["Modelo", "Tiempo", "1er token", "tok/s", "Razón.", "Resp.", "Checks", "finish"], rows));
    const failed = records.flatMap((r) => {
      const x = r.resultados.find((y) => y.tarea === task.id);
      if (!x || x.vacia) return [];
      const bad = Object.entries(x.checks).filter(([, v]) => !v).map(([k]) => k);
      return bad.length ? [`${r.label}: falla ${bad.join(", ")}`] : [];
    });
    for (const f of failed) console.log(`  ${f}`);
  }
  console.log("");
}

// ------------------------------------------------------------------- main

(async () => {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message + "\n\n" + USAGE);
    process.exit(1);
  }
  if (args.help || (!args.model && !args.compare && !args.list)) {
    console.log(USAGE);
    return;
  }

  try {
    if (args.list) {
      const config = loadJson(path.join(ROOT, "data", "config.json"));
      const url = args.url || config.lmstudio_url;
      const models = await listModels(url);
      console.log(models.length ? models.join("\n") : "LM Studio responde pero no tiene ningún modelo cargado");
      return;
    }
    if (args.compare) return compare(args.out);
    await runBench(args);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
})();
