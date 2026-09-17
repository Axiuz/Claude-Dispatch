// Plan de commits: lo que el agente documenter devuelve al cerrar una tarea,
// convertido en algo que la tarjeta de Control de código pueda ejecutar.
//
// El formato es el que pide CLAUDE.md, en bloques de texto plano:
//
//   COMMIT: repinta el panel
//   ARCHIVOS:
//   public/styles.css
//   public/index.html
//   MENSAJE:
//   Repinta el panel con la paleta oro y teal
//
//   Cuerpo opcional del commit.
//   FIN
//
// El parseo es tolerante a propósito: el documenter corre en un modelo de 4B y
// se le escapa el FIN, numera los bloques, mete viñetas en la lista o envuelve
// todo en un bloque de código. Nada de eso debería obligar a repegar el plan.
// Lo que no se negocia son las rutas: van a `git add`, así que pasan por el
// mismo filtro que las del panel (relPathError).

const { relPathError } = require("./git");

const MAX_COMMITS = 40;
const MAX_FILES = 200;
const MAX_MESSAGE = 5000;
const MAX_TITLE = 120;

// Encabezados de bloque. Se aceptan con y sin acento, numerados ("COMMIT 2:") y
// con el valor en la misma línea ("ARCHIVOS: a.js, b.js").
const HEAD_COMMIT = /^\s*commit\s*(?:#?\d+)?\s*[:.\-—]?\s*(.*)$/i;
const HEAD_FILES = /^\s*archivos?\s*[:.\-—]?\s*(.*)$/i;
const HEAD_MESSAGE = /^\s*mensaje\s*[:.\-—]?\s*(.*)$/i;
const HEAD_END = /^\s*fin\s*[.:]?\s*$/i;
const FENCE = /^\s*```/;
const BULLET = /^\s*[-*•]\s+/;

const clean = (s) => String(s == null ? "" : s).replace(/\r/g, "").trim();

// Una lista de archivos puede venir por líneas o separada por comas en la misma
// línea del encabezado. Las viñetas y las comillas sobran en ambos casos.
function splitFiles(text) {
  return clean(text)
    .split(/[,\n]/)
    .map((f) => f.replace(BULLET, "").replace(/^["'`]|["'`]$/g, "").trim())
    .filter(Boolean);
}

// El título es lo que se ve en la tarjeta; si el bloque no trae uno se usa la
// primera línea del mensaje, que es justo el resumen del commit.
function titleOf(title, message) {
  const t = clean(title) || clean(message).split("\n")[0] || "";
  return t.slice(0, MAX_TITLE);
}

function parseCommitPlan(text) {
  const lines = clean(text).split("\n");
  const commits = [];
  let current = null;    // bloque que se está leyendo
  let section = null;    // "files" | "message", según el último encabezado

  const flush = () => {
    if (!current) return;
    const message = clean(current.message.join("\n"));
    const files = current.files;
    // Un bloque sin nada dentro no es un commit, es ruido del modelo
    if (message || files.length) {
      commits.push({ title: titleOf(current.title, message), files, message });
    }
    current = null;
    section = null;
  };

  for (const line of lines) {
    if (FENCE.test(line)) continue;

    const head = line.match(HEAD_COMMIT);
    if (head) {
      // Sin FIN de por medio, un COMMIT nuevo cierra el anterior
      flush();
      current = { title: head[1], files: [], message: [] };
      section = null;
      continue;
    }
    if (!current) continue;

    if (HEAD_END.test(line)) {
      flush();
      continue;
    }

    const files = line.match(HEAD_FILES);
    if (files) {
      section = "files";
      current.files.push(...splitFiles(files[1]));
      continue;
    }
    const message = line.match(HEAD_MESSAGE);
    if (message) {
      section = "message";
      if (clean(message[1])) current.message.push(clean(message[1]));
      continue;
    }

    if (section === "files") current.files.push(...splitFiles(line));
    else if (section === "message") current.message.push(line);
  }
  flush();

  return normalizeCommits(commits);
}

// Puerta única: todo lo que se guarda pasa por aquí, venga del parser o de un
// POST con el plan ya en JSON. Deja fuera las rutas que git no debería ver.
function normalizeCommits(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];

  for (const raw of list.slice(0, MAX_COMMITS)) {
    if (!raw || typeof raw !== "object") continue;
    const message = clean(raw.message).slice(0, MAX_MESSAGE);
    const seen = new Set();
    const files = [];
    for (const f of Array.isArray(raw.files) ? raw.files : []) {
      const p = clean(f);
      if (!p || relPathError(p) || seen.has(p)) continue;
      seen.add(p);
      if (files.length < MAX_FILES) files.push(p);
    }
    if (!message && !files.length) continue;
    out.push({ title: titleOf(raw.title, message), files, message });
  }
  return out;
}

module.exports = { parseCommitPlan, normalizeCommits, MAX_COMMITS, MAX_FILES, MAX_MESSAGE };
