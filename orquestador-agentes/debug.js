// Las comprobaciones que ejecuta el botón "Ejecutar diagnóstico" del panel:
// entorno, datos en disco, sintaxis, tests unitarios, endpoints, seguridad,
// LM Studio, el rebuild de la app y el reinicio del servidor.
//
// El módulo no sabe de express ni de SSE: recibe un contexto —rutas, puerto,
// config, agentes y un restart()— y devuelve un resultado por paso. Quien los
// reparte al panel es server.js, así que el catálogo, la selección de pasos y el
// resumen se prueban sin levantar nada.

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const SMOKE_ENDPOINTS = [
  "/api/status",
  "/api/manifest",
  "/api/config",
  "/api/agents",
  "/api/runs",
  "/api/plan",
  "/api/projects",
  "/api/terminals",
  "/api/claude-usage",
];

const REQUIRED_CONFIG = ["lmstudio_url", "model", "app_port", "max_parallel", "max_prompt_chars"];

// Cada caso dice qué se pide y qué código tiene que contestar el servidor. Un
// 200 aquí no es un test que falla: es una puerta abierta.
const SECURITY_CASES = [
  { label: "archivo fuera de Proyectos", path: "/api/files/read?path=/etc/passwd", expect: 403 },
  { label: "git fuera de Proyectos", path: "/api/git?path=/etc", expect: 403 },
  { label: "árbol fuera de Proyectos", path: "/api/files/tree?path=/", expect: 403 },
  { label: "Host ajeno (DNS rebinding)", path: "/api/status", headers: { Host: "evil.example" }, expect: 403 },
  { label: "Origin ajeno", path: "/api/status", headers: { Origin: "http://evil.example" }, expect: 403 },
];

// Corriendo desde el repositorio hay tests que correr y una app que recompilar;
// dentro del bundle de la app no existe ninguna de las dos cosas, y eso se nota
// por lo que hay un nivel más arriba.
function repoRootFrom(appRoot) {
  const up = path.resolve(appRoot, "..");
  const conScripts = fs.existsSync(path.join(up, "Scripts", "build-dmg.sh"));
  const conTests = fs.existsSync(path.join(appRoot, "test"));
  return conScripts && conTests ? up : null;
}

// Una petición al servidor por su puerto de verdad, con tope de espera. Devuelve
// el código, el texto y si se pudo parsear como JSON; un error de red no rompe
// el diagnóstico, sale como estado 0.
function request(port, urlPath, options = {}) {
  const { method = "GET", headers = {}, body = null, timeoutMs = 10000 } = options;
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers: body ? { "Content-Type": "application/json", ...headers } : headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          // parsed y no "json !== null": /api/plan contesta null cuando no hay
          // plan, y eso es una respuesta buena, no un endpoint roto
          let json = null;
          let parsed = true;
          try {
            json = JSON.parse(text);
          } catch (_) {
            parsed = false;
          }
          resolve({ status: res.statusCode, text, json, parsed });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`sin respuesta en ${timeoutMs} ms`));
    });
    req.on("error", (err) => resolve({ status: 0, text: String(err.message || err), json: null }));
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// Un comando del sistema con su salida junta —stdout y stderr— y un tope de
// tiempo que lo mata. onLine recibe cada línea en cuanto aparece: el rebuild dura
// minutos y el panel lo enseña mientras corre.
function exec(cmd, args, options = {}) {
  const { cwd, timeoutMs = 120000, onLine = null } = options;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let output = "";
    let resto = "";
    const absorb = (chunk) => {
      const text = String(chunk);
      output += text;
      if (!onLine) return;
      resto += text;
      const lines = resto.split("\n");
      resto = lines.pop();
      lines.forEach((line) => onLine(line));
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
    const timer = setTimeout(() => {
      output += `\n[cortado: pasó de ${Math.round(timeoutMs / 1000)} s]`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (resto && onLine) onLine(resto);
      resolve({ code, output: output.trim() });
    });
  });
}

const jsFiles = (dir) => {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => path.join(dir, name));
  } catch (_) {
    return [];
  }
};

const ok = (summary, output = "") => ({ ok: true, summary, output });
const bad = (summary, output = "") => ({ ok: false, summary, output });
const skip = (summary) => ({ ok: true, skipped: true, summary, output: "" });

const STEPS = [
  {
    id: "entorno",
    label: "Entorno",
    hint: "Node, rutas y carpeta de datos",
    async run(ctx) {
      const lines = [
        `node ${process.version} (${process.platform}/${process.arch})`,
        `pid ${process.pid}, ${Math.round(process.uptime())} s en pie`,
        `servidor ${ctx.appRoot}`,
        `datos ${ctx.dataDir}`,
        `modo ${ctx.repoRoot ? "repositorio" : "bundle de la app"}`,
      ];
      const sonda = path.join(ctx.dataDir, ".debug-escritura");
      try {
        fs.writeFileSync(sonda, "ok");
        fs.unlinkSync(sonda);
      } catch (err) {
        return bad("la carpeta de datos no admite escritura", `${lines.join("\n")}\n${err.message}`);
      }
      return ok(`node ${process.version} · ${ctx.repoRoot ? "repositorio" : "bundle"}`, lines.join("\n"));
    },
  },
  {
    id: "datos",
    label: "Datos en disco",
    hint: "Los JSON parsean y la config está completa",
    async run(ctx) {
      const lines = [];
      const fallos = [];
      for (const name of fs.readdirSync(ctx.dataDir).filter((f) => f.endsWith(".json"))) {
        const file = path.join(ctx.dataDir, name);
        try {
          JSON.parse(fs.readFileSync(file, "utf8"));
          lines.push(`✓ ${name} (${fs.statSync(file).size} B)`);
        } catch (err) {
          fallos.push(name);
          lines.push(`✗ ${name}: ${err.message}`);
        }
      }
      const faltan = REQUIRED_CONFIG.filter((key) => ctx.config[key] === undefined);
      if (faltan.length) {
        fallos.push("config.json");
        lines.push(`✗ config.json sin ${faltan.join(", ")}`);
      }
      const agentes = ctx.agents.filter((a) => a.enabled !== false);
      lines.push(`${agentes.length} agentes habilitados: ${agentes.map((a) => a.id).join(", ")}`);
      const sinUseWhen = agentes.filter((a) => !a.use_when);
      if (sinUseWhen.length) lines.push(`⚠ sin use_when: ${sinUseWhen.map((a) => a.id).join(", ")}`);
      return fallos.length
        ? bad(`${fallos.length} archivos con problemas`, lines.join("\n"))
        : ok(`${lines.length} comprobaciones`, lines.join("\n"));
    },
  },
  {
    id: "sintaxis",
    label: "Sintaxis",
    hint: "node --check de cada .js y bash -n de los scripts",
    async run(ctx) {
      const archivos = [...jsFiles(ctx.appRoot), ...jsFiles(path.join(ctx.appRoot, "public"))];
      const fallos = [];
      for (const file of archivos) {
        const res = await exec(process.execPath, ["--check", file], { timeoutMs: 15000 });
        if (res.code !== 0) fallos.push(`✗ ${path.relative(ctx.appRoot, file)}\n${res.output}`);
      }
      const scripts = ctx.repoRoot
        ? [path.join(ctx.repoRoot, "Scripts", "build-dmg.sh"), path.join(ctx.repoRoot, "macos", "launcher.sh")].filter((f) => fs.existsSync(f))
        : [];
      for (const file of scripts) {
        const res = await exec("bash", ["-n", file], { timeoutMs: 15000 });
        if (res.code !== 0) fallos.push(`✗ ${path.relative(ctx.repoRoot, file)}\n${res.output}`);
      }
      const total = archivos.length + scripts.length;
      return fallos.length
        ? bad(`${fallos.length} de ${total} con errores`, fallos.join("\n\n"))
        : ok(`${total} archivos sin errores`, [...archivos, ...scripts].map((f) => `✓ ${path.basename(f)}`).join("\n"));
    },
  },
  {
    id: "tests",
    label: "Tests unitarios",
    hint: "node --test sobre test/",
    async run(ctx) {
      const dir = path.join(ctx.appRoot, "test");
      if (!fs.existsSync(dir)) return skip("la app empaquetada no lleva los tests");
      const archivos = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => path.join("test", f));
      const res = await exec(process.execPath, ["--test", ...archivos], { cwd: ctx.appRoot, timeoutMs: 180000 });
      const cuenta = (etiqueta) => {
        const m = res.output.match(new RegExp(`^[#ℹ] ${etiqueta} (\\d+)$`, "m"));
        return m ? Number(m[1]) : null;
      };
      const pasan = cuenta("pass");
      const fallan = cuenta("fail");
      const resumen = pasan === null ? "" : `${pasan} pasan · ${fallan} fallan`;
      return res.code === 0
        ? ok(resumen || `${archivos.length} archivos`, res.output)
        : bad(resumen || "tests en rojo", res.output);
    },
  },
  {
    id: "http",
    label: "Endpoints",
    hint: "Una petición real a cada ruta del panel",
    async run(ctx) {
      const lines = [];
      const fallos = [];
      for (const ruta of SMOKE_ENDPOINTS) {
        const res = await request(ctx.port, ruta);
        const bien = res.status === 200 && res.parsed;
        lines.push(`${bien ? "✓" : "✗"} ${String(res.status).padStart(3)} ${ruta}`);
        if (!bien) fallos.push(ruta);
      }
      return fallos.length
        ? bad(`${fallos.length} de ${SMOKE_ENDPOINTS.length} fallan`, lines.join("\n"))
        : ok(`${SMOKE_ENDPOINTS.length} rutas responden`, lines.join("\n"));
    },
  },
  {
    id: "seguridad",
    label: "Seguridad",
    hint: "Rutas fuera de Proyectos, Host y Origin ajenos",
    async run(ctx) {
      const lines = [];
      const fallos = [];
      for (const caso of SECURITY_CASES) {
        const res = await request(ctx.port, caso.path, { headers: caso.headers || {} });
        const bien = res.status === caso.expect;
        lines.push(`${bien ? "✓" : "✗"} ${caso.label}: ${res.status} (se esperaba ${caso.expect})`);
        if (!bien) fallos.push(caso.label);
      }
      return fallos.length
        ? bad(`${fallos.length} puertas abiertas`, lines.join("\n"))
        : ok(`${SECURITY_CASES.length} intentos rechazados`, lines.join("\n"));
    },
  },
  {
    id: "modelo",
    label: "LM Studio",
    hint: "Alcanzable, con el modelo cargado, y una delegación de verdad",
    async run(ctx) {
      const estado = await request(ctx.port, "/api/status", { timeoutMs: 15000 });
      const info = estado.json || {};
      if (!info.reachable) return bad("LM Studio no responde", `${ctx.config.lmstudio_url}\n${estado.text}`);
      const lines = [`✓ ${ctx.config.lmstudio_url}`, `modelos: ${(info.models || []).join(", ") || "ninguno"}`];
      if (!info.model_loaded) lines.push(`⚠ ${ctx.config.model} no está cargado`);

      const agente = ctx.agents.find((a) => a.enabled !== false);
      if (!agente) return ok("sin agentes que probar", lines.join("\n"));
      const inicio = Date.now();
      const res = await request(ctx.port, `/agent/${agente.id}`, {
        method: "POST",
        body: { prompt: "Responde solo con la palabra PONG.", task_label: "diagnóstico" },
        timeoutMs: 120000,
      });
      const texto = res.json?.content || res.text;
      lines.push(`delegación a ${agente.id}: ${res.status} en ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
      lines.push(String(texto).slice(0, 400));
      return res.status === 200 && texto
        ? ok(`${agente.id} contestó en ${((Date.now() - inicio) / 1000).toFixed(1)} s`, lines.join("\n"))
        : bad("la delegación de prueba falló", lines.join("\n"));
    },
  },
  {
    id: "build",
    label: "Rebuild de la app",
    hint: "Scripts/build-dmg.sh: compila Singularity.app y el .dmg",
    optional: true,
    async run(ctx) {
      if (!ctx.repoRoot) return skip("no hay repositorio a mano: la app corre desde su bundle");
      const script = path.join(ctx.repoRoot, "Scripts", "build-dmg.sh");
      const res = await exec("bash", [script], { cwd: ctx.repoRoot, timeoutMs: 900000, onLine: ctx.onLine });
      const ultima = res.output.trim().split("\n").pop() || "";
      return res.code === 0 ? ok(ultima, res.output) : bad(`build-dmg.sh salió con ${res.code}`, res.output);
    },
  },
  {
    id: "reinicio",
    label: "Reiniciar el orquestador",
    hint: "Levanta el servidor de nuevo; cierra las terminales abiertas",
    optional: true,
    async run(ctx) {
      if (!ctx.restart) return skip("este servidor no sabe reiniciarse");
      const aviso = ctx.restart();
      return ok("reiniciando: el panel se reconecta solo", aviso);
    },
  },
];

const stepById = (id) => STEPS.find((s) => s.id === id);
const defaultStepIds = () => STEPS.filter((s) => !s.optional).map((s) => s.id);

function catalog() {
  return STEPS.map(({ id, label, hint, optional }) => ({ id, label, hint, optional: !!optional }));
}

// Los ids que pida el panel, en el orden del catálogo: el rebuild y el reinicio
// van al final porque el reinicio corta la conexión con el propio panel.
function planSteps(ids) {
  const pedidos = Array.isArray(ids) && ids.length ? ids : defaultStepIds();
  return STEPS.filter((step) => pedidos.includes(step.id));
}

function summarize(results) {
  const fallidos = results.filter((r) => !r.ok);
  const saltados = results.filter((r) => r.skipped);
  return {
    ok: fallidos.length === 0,
    total: results.length,
    failed: fallidos.length,
    skipped: saltados.length,
    ms: results.reduce((sum, r) => sum + (r.ms || 0), 0),
  };
}

async function runSteps(ids, ctx, onStep = () => {}) {
  const results = [];
  for (const step of planSteps(ids)) {
    onStep({ id: step.id, label: step.label, status: "running" });
    const inicio = Date.now();
    let res;
    try {
      res = await step.run({ ...ctx, onLine: (line) => onStep({ id: step.id, status: "log", line }) });
    } catch (err) {
      res = bad("reventó", String(err && err.stack ? err.stack : err));
    }
    const result = { id: step.id, label: step.label, ms: Date.now() - inicio, ...res };
    result.status = result.skipped ? "skip" : result.ok ? "ok" : "fail";
    results.push(result);
    onStep(result);
  }
  return results;
}

module.exports = { STEPS, catalog, planSteps, defaultStepIds, runSteps, summarize, repoRootFrom, request, exec, stepById, SMOKE_ENDPOINTS, SECURITY_CASES };
