// Cuántos tokens lleva gastados Claude Code, leyendo sus propios transcripts.
//
// Claude Code escribe cada sesión en ~/.claude/projects/<carpeta>/<sesión>.jsonl,
// una línea por entrada. Las entradas de tipo "assistant" traen el `usage` que
// devolvió la API: ahí está el gasto real, no una estimación por longitud.
//
// Dos cosas hay que tener en cuenta al sumar:
//   - Una misma respuesta aparece en varias líneas (razonamiento, texto, tool_use)
//     con el MISMO message.id y el mismo usage. Se cuenta una sola vez.
//   - Los archivos crecen por el final, así que guardamos el offset de cada uno y
//     releemos solo lo añadido. Un tick cuesta microsegundos, no relee 50 MB.
//
// El módulo no depende de express ni del servidor: recibe una raíz y avisa por
// callback. Así se puede probar con una carpeta de mentira.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SESSION_HOURS = 5;
const WEEK_HOURS = 7 * 24;
const DEFAULT_DAYS = 7; // ventana de archivos que se leen, por mtime
const ACTIVE_MS = 5 * 60 * 1000; // una sesión "activa" es la que escribió hace poco

// ---------- Helpers puros (los que prueban los tests) ----------

function usageRoot() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

// Clave de día en hora local: "hoy" es el hoy del usuario, no el de UTC
function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function hourOf(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / HOUR_MS);
}

function emptyTotals() {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, messages: 0 };
}

// Suma un usage de la API a un acumulador. El total incluye la caché: es lo que
// de verdad pasó por el modelo, aunque leer de caché cueste menos.
function addUsage(totals, usage) {
  if (!usage) return totals;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  totals.input += input;
  totals.output += output;
  totals.cacheCreate += cacheCreate;
  totals.cacheRead += cacheRead;
  totals.total += input + output + cacheCreate + cacheRead;
  totals.messages += 1;
  return totals;
}

// Una línea del transcript → {id, model, ts, day, usage}, o null si no aporta
// gasto (entradas del usuario, resultados de herramientas, líneas a medio escribir).
function parseEntry(line) {
  if (!line || line.indexOf('"usage"') === -1) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (_) {
    return null; // la última línea puede estar a medias mientras claude escribe
  }
  if (!entry || entry.type !== "assistant") return null;
  const message = entry.message;
  if (!message || typeof message !== "object" || !message.usage) return null;
  // "<synthetic>" son respuestas que fabrica el propio claude (errores de API,
  // avisos): llevan usage en cero y no son gasto real
  if (message.model === "<synthetic>") return null;
  const id = message.id || entry.requestId || entry.uuid;
  if (!id) return null;
  return {
    id,
    model: message.model || "desconocido",
    ts: entry.timestamp || null,
    day: entry.timestamp ? dayKey(entry.timestamp) : null,
    usage: message.usage,
  };
}

// Corta un Buffer en líneas completas y devuelve lo que quedó suelto, para que
// un carácter multibyte partido entre dos lecturas no se rompa.
function splitLines(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) {
      lines.push(buffer.slice(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  return { lines, rest: buffer.slice(start) };
}

function sumHours(byHour, fromHour, toHour) {
  const totals = emptyTotals();
  byHour.forEach((value, hour) => {
    if (hour < fromHour || hour > toHour) return;
    totals.input += value.input;
    totals.output += value.output;
    totals.cacheCreate += value.cacheCreate;
    totals.cacheRead += value.cacheRead;
    totals.total += value.total;
    totals.messages += value.messages;
  });
  return totals;
}

function sessionBlocks(byHour, blockHours = SESSION_HOURS) {
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const blocks = [];
  let current = null;
  for (const hour of hours) {
    // Un bloque dura blockHours desde su primera hora activa, aunque dentro no
    // haya actividad continua: así es como Claude Code cuenta una sesión
    if (!current || hour >= current.startHour + blockHours) {
      current = { startHour: hour, lastHour: hour, totals: emptyTotals() };
      blocks.push(current);
    }
    const value = byHour.get(hour);
    current.lastHour = hour;
    current.totals.input += value.input;
    current.totals.output += value.output;
    current.totals.cacheCreate += value.cacheCreate;
    current.totals.cacheRead += value.cacheRead;
    current.totals.total += value.total;
    current.totals.messages += value.messages;
  }
  return blocks.map((block) => ({
    startAt: new Date(block.startHour * HOUR_MS).toISOString(),
    resetAt: new Date((block.startHour + blockHours) * HOUR_MS).toISOString(),
    lastAt: new Date((block.lastHour + 1) * HOUR_MS).toISOString(),
    ...block.totals,
  }));
}

function activeBlock(blocks, now = Date.now()) {
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  return Date.parse(last.resetAt) > now ? last : null;
}

// ---------- Tracker ----------

function createTracker(options = {}) {
  const root = options.root || usageRoot();
  const days = options.days || DEFAULT_DAYS;
  const onChange = options.onChange || (() => {});
  const pollMs = options.pollMs ?? 4000;
  const blockHours = options.blockHours || SESSION_HOURS;

  const files = new Map(); // ruta -> {offset, rest, day, mtimeMs, tokens}
  const seen = new Set(); // message.id ya contados
  const byDay = new Map(); // "YYYY-MM-DD" -> totals
  const byModel = new Map(); // modelo -> totals
  const byHour = new Map(); // hora epoch -> totals, para los bloques de sesión
  const all = emptyTotals();

  let lastAt = null;
  let available = true;
  let dirty = false;
  let watchers = [];
  let timer = null;
  let debounce = null;

  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, emptyTotals());
    return map.get(key);
  };

  function count(entry, file) {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    const day = entry.day || dayKey(new Date());
    addUsage(all, entry.usage);
    addUsage(bucket(byDay, day), entry.usage);
    addUsage(bucket(byModel, entry.model), entry.usage);
    const hour = (entry.ts && hourOf(entry.ts)) || hourOf(new Date());
    addUsage(bucket(byHour, hour), entry.usage);
    if (file) {
      file.day = day;
      file.tokens += (entry.usage.input_tokens || 0) + (entry.usage.output_tokens || 0);
    }
    if (entry.ts && (!lastAt || entry.ts > lastAt)) lastAt = entry.ts;
    dirty = true;
  }

  // Lee solo lo que se añadió al archivo desde la última vez
  function readFile(file, filePath) {
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch (_) {
      return;
    }
    if (size < file.offset) {
      // el archivo se truncó o se reemplazó: volver a empezar por él
      file.offset = 0;
      file.rest = Buffer.alloc(0);
    }
    if (size === file.offset) return;

    let fd;
    try {
      fd = fs.openSync(filePath, "r");
    } catch (_) {
      return;
    }
    try {
      const length = size - file.offset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, file.offset);
      file.offset = size;
      const { lines, rest } = splitLines(Buffer.concat([file.rest, buf]));
      file.rest = rest;
      for (const line of lines) {
        const entry = parseEntry(line);
        if (entry) count(entry, file);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  function scan() {
    let projects;
    try {
      projects = fs.readdirSync(root, { withFileTypes: true });
      available = true;
    } catch (_) {
      // Sin carpeta de transcripts no hay nada que medir (Claude Code no ha
      // corrido nunca en esta máquina, o vive en otro CLAUDE_CONFIG_DIR)
      if (available) dirty = true;
      available = false;
      return;
    }

    const cutoff = Date.now() - days * DAY_MS;
    for (const dir of projects) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(root, dir.name);
      let entries;
      try {
        entries = fs.readdirSync(dirPath);
      } catch (_) {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const filePath = path.join(dirPath, name);
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch (_) {
          continue;
        }
        const known = files.get(filePath);
        if (!known && stat.mtimeMs < cutoff) continue; // fuera de la ventana
        if (known && known.mtimeMs === stat.mtimeMs) continue; // sin cambios
        const file = known || { offset: 0, rest: Buffer.alloc(0), day: null, tokens: 0 };
        file.mtimeMs = stat.mtimeMs;
        files.set(filePath, file);
        readFile(file, filePath);
      }
    }
  }

  function sessionCounts() {
    const today = dayKey(new Date());
    const now = Date.now();
    let todayCount = 0;
    let active = 0;
    files.forEach((file) => {
      if (file.day !== today) return;
      todayCount++;
      if (now - file.mtimeMs < ACTIVE_MS) active++;
    });
    return { today: todayCount, active };
  }

  function snapshot() {
    const today = dayKey(new Date());
    const models = [...byModel.entries()]
      .map(([model, totals]) => ({ model, ...totals }))
      .sort((a, b) => b.total - a.total);
    const history = [...byDay.entries()]
      .map(([day, totals]) => ({ day, ...totals }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
    const nowHour = hourOf(new Date());
    const blocks = sessionBlocks(byHour, blockHours);
    const current = activeBlock(blocks, Date.now());
    return {
      available,
      days,
      blockHours,
      today: { ...(byDay.get(today) || emptyTotals()) },
      window: { ...all },
      session: current
        ? { ...current, active: true }
        : {
            ...emptyTotals(),
            active: false,
            startAt: null,
            resetAt: null,
            lastAt: blocks.length ? blocks[blocks.length - 1].lastAt : null,
          },
      weekly: {
        ...sumHours(byHour, nowHour - WEEK_HOURS + 1, nowHour),
        sinceAt: new Date((nowHour - WEEK_HOURS + 1) * HOUR_MS).toISOString(),
        hours: WEEK_HOURS,
      },
      models,
      history,
      sessions: sessionCounts(),
      lastAt,
    };
  }

  function tick() {
    dirty = false;
    scan();
    if (dirty) onChange(snapshot());
  }

  function start() {
    tick();
    try {
      // fs.watch recursivo funciona en macOS; si falla nos queda el intervalo
      watchers.push(
        fs.watch(root, { recursive: true, persistent: false }, () => {
          if (debounce) return;
          debounce = setTimeout(() => {
            debounce = null;
            tick();
          }, 400);
        })
      );
    } catch (_) {}
    if (pollMs) {
      timer = setInterval(tick, pollMs);
      if (timer.unref) timer.unref();
    }
    return snapshot();
  }

  function stop() {
    watchers.forEach((w) => {
      try {
        w.close();
      } catch (_) {}
    });
    watchers = [];
    if (timer) clearInterval(timer);
    if (debounce) clearTimeout(debounce);
    timer = null;
    debounce = null;
  }

  return { start, stop, tick, snapshot, root };
}

module.exports = {
  createTracker,
  usageRoot,
  dayKey,
  hourOf,
  emptyTotals,
  addUsage,
  parseEntry,
  splitLines,
  sessionBlocks,
  activeBlock,
  sumHours,
  SESSION_HOURS,
  WEEK_HOURS,
  HOUR_MS,
};
