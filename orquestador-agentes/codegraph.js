// ============================================================================
// codegraph.js — escáner estático de un proyecto: qué funciones hay, dónde
// están y quién las llama. Sin dependencias y sin AST: una tabla de lenguajes
// con expresiones regulares por línea.
//
// El resultado alimenta la pestaña "Mapa" del panel. No es un compilador: se
// asume ruido y las aristas dudosas se marcan con `ambiguous`.
// ============================================================================

const fs = require("fs");
const path = require("path");

// ============ Tabla de lenguajes ============
// Cada entrada describe cómo reconocer, en ESE lenguaje:
//   exts         extensiones del archivo
//   lineComment  marcas de comentario hasta fin de línea
//   blockComment pares [abre, cierra]
//   quotes       delimitadores de cadena (los más largos primero: """ antes de ")
//   defs         [{ re, kind, name }] — re se prueba línea por línea; `name` es
//                el número de grupo con el identificador
//   imports      [{ re, name }] — el grupo apunta al módulo/ruta importada
//   callable     false si el lenguaje no tiene llamadas con paréntesis
//
// Añadir un lenguaje = añadir una entrada. No hay que tocar nada más.

const LANGS = {
  js: {
    label: "JavaScript",
    exts: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"', "'", "`"],
    multiline: ["`"],
    regexLiterals: true,
    defs: [
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function", name: 1 },
      { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", name: 1 },
      { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, kind: "arrow", name: 1 },
      { re: /^\s{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{\s*$/, kind: "method", name: 1 },
    ],
    imports: [
      { re: /^\s*import\s+[^;]*?from\s*["']([^"']+)["']/, name: 1 },
      { re: /^\s*import\s*["']([^"']+)["']/, name: 1 },
      { re: /^\s*export\s+[^;]*?from\s*["']([^"']+)["']/, name: 1 },
      { re: /require\s*\(\s*["']([^"']+)["']\s*\)/, name: 1 },
      { re: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/, name: 1 },
    ],
    resolveExts: [".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".json"],
    indexFiles: ["index.js", "index.ts", "index.tsx", "index.jsx", "index.mjs"],
  },

  py: {
    label: "Python",
    exts: [".py", ".pyw"],
    lineComment: ["#"],
    blockComment: [],
    quotes: ['"""', "'''", '"', "'"],
    multiline: ['"""', "'''"],
    blockScope: "indent",
    defs: [
      { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class", name: 1 },
      { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function", name: 1 },
    ],
    imports: [
      { re: /^\s*from\s+([.\w]+)\s+import\s+/, name: 1 },
      { re: /^\s*import\s+([.\w]+)/, name: 1 },
    ],
    importStyle: "dotted",
    resolveExts: [".py"],
    indexFiles: ["__init__.py"],
  },

  java: {
    label: "Java",
    exts: [".java"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"', "'"],
    defs: [
      { re: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, kind: "class", name: 1 },
      { re: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[^>]+>\s*)?[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/, kind: "method", name: 1 },
    ],
    imports: [{ re: /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/, name: 1 }],
    importStyle: "package",
    resolveExts: [".java"],
    indexFiles: [],
  },

  cs: {
    label: "C#",
    exts: [".cs"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"', "'"],
    defs: [
      { re: /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|struct|record|enum)\s+([A-Za-z_]\w*)/, kind: "class", name: 1 },
      { re: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|partial|abstract|extern)\s+)+(?:<[^>]+>\s*)?[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/, kind: "method", name: 1 },
    ],
    imports: [{ re: /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/, name: 1 }],
    importStyle: "package",
    resolveExts: [".cs"],
    indexFiles: [],
  },

  php: {
    label: "PHP",
    exts: [".php"],
    lineComment: ["//", "#"],
    blockComment: [["/*", "*/"]],
    quotes: ['"', "'"],
    defs: [
      { re: /^\s*(?:final\s+|abstract\s+)?(?:class|trait|interface)\s+([A-Za-z_]\w*)/, kind: "class", name: 1 },
      { re: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)/, kind: "function", name: 1 },
    ],
    imports: [
      { re: /(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/, name: 1 },
      { re: /^\s*use\s+([\w\\]+)/, name: 1 },
    ],
    resolveExts: [".php"],
    indexFiles: ["index.php"],
  },

  go: {
    label: "Go",
    exts: [".go"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"', "`", "'"],
    multiline: ["`"],
    defs: [
      { re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: "type", name: 1 },
      { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function", name: 1 },
    ],
    imports: [{ re: /^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"\s*$/, name: 1 }],
    resolveExts: [".go"],
    indexFiles: [],
  },

  sql: {
    label: "SQL",
    exts: [".sql"],
    lineComment: ["--", "#"],
    blockComment: [["/*", "*/"]],
    quotes: ["'", '"', "`"],
    defs: [
      { re: /^\s*create\s+(?:or\s+replace\s+)?(?:definer\s*=\s*\S+\s+)?function\s+(?:if\s+not\s+exists\s+)?[`"']?([\w.]+)/i, kind: "function", name: 1 },
      { re: /^\s*create\s+(?:or\s+replace\s+)?(?:definer\s*=\s*\S+\s+)?procedure\s+(?:if\s+not\s+exists\s+)?[`"']?([\w.]+)/i, kind: "procedure", name: 1 },
      { re: /^\s*create\s+(?:or\s+replace\s+)?(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?[`"']?([\w.]+)/i, kind: "table", name: 1 },
      { re: /^\s*create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?[`"']?([\w.]+)/i, kind: "view", name: 1 },
      { re: /^\s*create\s+(?:or\s+replace\s+)?trigger\s+(?:if\s+not\s+exists\s+)?[`"']?([\w.]+)/i, kind: "trigger", name: 1 },
    ],
    imports: [],
    resolveExts: [],
    indexFiles: [],
  },

  sh: {
    label: "Shell",
    exts: [".sh", ".bash", ".zsh"],
    lineComment: ["#"],
    blockComment: [],
    quotes: ['"', "'"],
    defs: [
      { re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/, kind: "function", name: 1 },
      { re: /^\s*function\s+([A-Za-z_]\w*)\s*\{?/, kind: "function", name: 1 },
    ],
    imports: [{ re: /^\s*(?:source|\.)\s+["']?([^"'\s;]+)/, name: 1 }],
    // En shell se llama por nombre, sin paréntesis: al principio de la línea o
    // tras una tubería, un punto y coma o una sustitución.
    callRe: /(?:^|\||;|&&|\$\(|`)\s*([A-Za-z_][\w-]*)/g,
    callName: 1,
    resolveExts: [".sh", ".bash"],
    indexFiles: [],
  },

  prisma: {
    label: "Prisma",
    exts: [".prisma"],
    lineComment: ["//"],
    blockComment: [],
    quotes: ['"'],
    defs: [
      { re: /^\s*(?:model|enum|generator|datasource|type)\s+([A-Za-z_]\w*)/, kind: "model", name: 1 },
    ],
    imports: [],
    // Un campo `author User` es una referencia al modelo User
    callRe: /^\s*\w+\s+([A-Z]\w*)/g,
    callName: 1,
    resolveExts: [],
    indexFiles: [],
  },
};

// Palabras que van seguidas de paréntesis pero no son llamadas
const CONTROL_WORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "class", "def",
  "elif", "else", "do", "try", "with", "print", "typeof", "instanceof", "new",
  "await", "yield", "throw", "case", "in", "of", "and", "or", "not", "lambda",
  "public", "private", "protected", "static", "void", "synchronized", "assert",
  "select", "from", "where", "values", "set", "and", "on", "when", "then",
  "require", "import", "export", "constructor", "super", "this", "self",
  "using", "namespace", "foreach", "lock", "sizeof", "delegate", "base",
  "echo", "exit", "fi", "esac", "done", "local", "unset", "shift", "eval",
  "insert", "update", "delete", "create", "table", "view", "trigger", "as",
]);

// ============ Recorrido de archivos ============

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt",
  "vendor", "__pycache__", ".venv", "venv", "target", ".gradle", ".idea",
  ".vscode", ".turbo", ".cache", "tmp", "bin", "obj", "Pods", ".terraform",
]);

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 500 * 1024;
const MAX_LINE_LENGTH = 2000; // más que esto huele a archivo minificado

function langForFile(file) {
  const ext = path.extname(file).toLowerCase();
  for (const [id, lang] of Object.entries(LANGS)) {
    if (lang.exts.includes(ext)) return { id, ...lang };
  }
  return null;
}

// Recorre el árbol y devuelve rutas relativas, ordenadas. No sigue symlinks.
function walk(root) {
  const found = [];
  const stack = [root];
  while (stack.length && found.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (entry.name.includes(".min.")) continue;
        if (found.length >= MAX_FILES) break;
        found.push(path.relative(root, full));
      }
    }
  }
  return found.sort();
}

function readSource(abs) {
  try {
    if (fs.statSync(abs).size > MAX_FILE_BYTES) return null;
    const code = fs.readFileSync(abs, "utf-8");
    if (code.indexOf(String.fromCharCode(0)) !== -1) return null; // binario
    const longest = code.split("\n").reduce((n, l) => Math.max(n, l.length), 0);
    if (longest > MAX_LINE_LENGTH) return null;
    return code;
  } catch (_) {
    return null;
  }
}

// ============ Limpieza de comentarios y cadenas ============
// Sustituye comentarios y contenido de cadenas por espacios, conservando los
// saltos de línea: así los números de línea siguen siendo válidos y no
// confundimos `foo()` dentro de un comentario con una llamada real.

const blank = (s) => s.replace(/[^\n]/g, " ");

// Después de estos caracteres, una barra abre una expresión regular; después de
// un identificador o un cierre de paréntesis, es una división.
const REGEX_PREFIX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "~", "<", ">", "\n"]);

function regexAllowed(out) {
  for (let k = out.length - 1; k >= 0; k--) {
    const ch = out[k];
    if (ch === " " || ch === "\t") continue;
    return REGEX_PREFIX.has(ch);
  }
  return true;
}

const lineEnd = (code, i) => {
  const nl = code.indexOf("\n", i);
  return nl === -1 ? code.length : nl;
};

// keepStrings: deja el contenido de las cadenas intacto y solo borra los
// comentarios. Hace falta para leer los imports, cuya ruta ES una cadena.
function stripNoise(code, lang, keepStrings) {
  const lineMarks = lang.lineComment || [];
  const blocks = lang.blockComment || [];
  const quotes = [...(lang.quotes || [])].sort((a, b) => b.length - a.length);
  let out = "";
  let i = 0;

  while (i < code.length) {
    // Literales de expresión regular: /algo/ lleva dentro comillas y barras que
    // no son ni cadenas ni comentarios. Sin esto, un /'/ desincroniza el resto.
    if (lang.regexLiterals && code[i] === "/" && code[i + 1] !== "/" && code[i + 1] !== "*" && regexAllowed(out)) {
      const limit = lineEnd(code, i);
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < limit) {
        const ch = code[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        out += blank(code.slice(i, j));
        i = j;
        continue;
      }
    }

    const lineMark = lineMarks.find((m) => code.startsWith(m, i));
    if (lineMark) {
      const nl = code.indexOf("\n", i);
      const end = nl === -1 ? code.length : nl;
      out += blank(code.slice(i, end));
      i = end;
      continue;
    }

    const block = blocks.find(([open]) => code.startsWith(open, i));
    if (block) {
      const closeAt = code.indexOf(block[1], i + block[0].length);
      const end = closeAt === -1 ? code.length : closeAt + block[1].length;
      out += blank(code.slice(i, end));
      i = end;
      continue;
    }

    const quote = quotes.find((q) => code.startsWith(q, i));
    if (quote) {
      // Salvo las comillas multilínea (backtick, """), una cadena termina en su
      // línea. Así un apóstrofo suelto dentro de un texto no se come el archivo.
      const multiline = (lang.multiline || []).includes(quote);
      const limit = multiline ? code.length : lineEnd(code, i);
      let j = i + quote.length;
      let closed = false;
      while (j < limit) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code.startsWith(quote, j)) {
          j += quote.length;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed && !multiline) {
        out += code[i]; // comilla suelta: carácter normal
        i++;
        continue;
      }
      const end = Math.min(j, code.length);
      const text = code.slice(i, end);
      out += keepStrings ? text : blank(text);
      i = end;
      continue;
    }

    out += code[i];
    i++;
  }
  return out;
}

// ============ Extracción ============

// Definiciones de funciones/clases/métodos, con su línea (1-indexada).
function extractDefs(code, lang) {
  const lines = code.split("\n");
  const defs = [];
  const seen = new Set();

  lines.forEach((line, idx) => {
    for (const rule of lang.defs || []) {
      const m = line.match(rule.re);
      if (!m) continue;
      const name = m[rule.name];
      if (!name || CONTROL_WORDS.has(name)) continue;
      const key = `${name}:${idx + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      defs.push({ name, kind: rule.kind, line: idx + 1 });
      break; // una definición por línea
    }
  });

  defs.forEach((def) => {
    def.endLine = endOfDef(lines, def, lang);
  });
  return defs;
}

// Hasta dónde llega el cuerpo de una definición: contando llaves, o por
// indentación en lenguajes que no las usan (Python). De esto depende saber
// dentro de qué función cae cada llamada.
function endOfDef(lines, def, lang) {
  const start = def.line - 1;
  if (lang.blockScope === "indent") {
    const indent = lines[start].search(/\S/);
    for (let i = start + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      if (lines[i].search(/\S/) <= indent) return i;
    }
    return lines.length;
  }

  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length && i <= start + 400; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) return i + 1;
    // Definición de una línea sin llaves: `const f = (x) => x * 2;`
    if (!opened && i === start && /;\s*$/.test(lines[i])) return def.line;
  }
  return Math.min(lines.length, start + 400);
}

// Módulos importados por el archivo, tal cual aparecen escritos.
function extractImports(code, lang) {
  const found = [];
  const seen = new Set();
  code.split("\n").forEach((line, idx) => {
    for (const rule of lang.imports || []) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
      let m;
      while ((m = re.exec(line))) {
        const spec = m[rule.name];
        if (!spec || seen.has(spec)) continue;
        seen.add(spec);
        found.push({ spec, line: idx + 1 });
      }
    }
  });
  return found;
}

// Llamadas `nombre(` o `algo.nombre(`, con la función que las contiene.
function extractCalls(code, lang, defs) {
  if (lang.callable === false) return [];
  const calls = [];
  // Por defecto: nombre seguido de paréntesis, con receptor opcional
  // (obj.metodo). Algunos lenguajes llaman de otra forma y traen su propia
  // expresión: shell por nombre suelto, Prisma por referencia a un modelo.
  const re = lang.callRe || /(?:([A-Za-z_$][\w$]*)\s*[.:]{1,2}\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
  const nameGroup = lang.callName || 2;

  code.split("\n").forEach((line, idx) => {
    const lineNo = idx + 1;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const name = m[nameGroup];
      if (!name) continue;
      if (CONTROL_WORDS.has(name)) continue;
      // La propia línea de la definición no es una llamada
      if (defs.some((d) => d.line === lineNo && d.name === name)) continue;
      const receiver = nameGroup === 2 ? m[1] || null : null;
      calls.push({ name, receiver, line: lineNo, enclosing: enclosingDef(defs, lineNo) });
    }
  });
  return calls;
}

function enclosingDef(defs, line) {
  let best = null;
  for (const def of defs) {
    if (def.line <= line && line <= def.endLine) {
      if (!best || def.line > best.line) best = def;
    }
  }
  return best ? best.name : null;
}

// ============ Resolución de imports relativos ============

// "./utils" desde "src/app.js" → "src/utils.js" si ese archivo existe.
// Lenguajes con imports por paquete (Java, C#) o con puntos (Python) traen su
// importStyle y se traducen antes a una ruta.
function resolveImport(spec, fromFile, fileSet, lang) {
  if (lang.importStyle === "dotted") spec = dottedToPath(spec);
  if (lang.importStyle === "package") return resolvePackage(spec, fileSet, lang);
  if (!spec.startsWith(".")) return null; // paquete externo: fuera del mapa
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(toPosix(fromFile)), spec));
  const candidates = [base];
  for (const ext of lang.resolveExts || []) candidates.push(base + ext);
  for (const idx of lang.indexFiles || []) candidates.push(path.posix.join(base, idx));
  return candidates.find((c) => fileSet.has(c)) || null;
}

// Python: "from .utils import x" → "./utils"; "..pkg.mod" → "../pkg/mod"
function dottedToPath(spec) {
  const m = spec.match(/^(\.+)(.*)$/);
  if (!m) return spec; // import absoluto: es un paquete instalado
  const ups = m[1].length;
  const rest = m[2].replace(/\./g, "/");
  return (ups === 1 ? "./" : "../".repeat(ups - 1)) + rest;
}

// Java/C#: "com.empresa.Servicio" → el archivo cuyo camino termina así
function resolvePackage(spec, fileSet, lang) {
  const base = spec.replace(/\./g, "/");
  for (const ext of lang.resolveExts || []) {
    const suffix = base + ext;
    for (const file of fileSet) {
      if (file === suffix || file.endsWith("/" + suffix)) return file;
    }
  }
  return null;
}

const toPosix = (p) => p.split(path.sep).join("/");

// ============ Construcción del grafo ============

const fileId = (rel) => `f:${rel}`;
const fnId = (rel, name) => `fn:${rel}#${name}`;

function buildGraph(root) {
  const started = Date.now();
  const rels = walk(root);
  const analyzed = [];
  const skipped = [];

  // --- 1ª pasada: leer, extraer definiciones e imports
  for (const rel of rels) {
    const relPosix = toPosix(rel);
    const lang = langForFile(rel);
    const code = lang ? readSource(path.join(root, rel)) : null;
    if (!lang || code === null) {
      skipped.push({ rel: relPosix, lang: lang ? lang.id : null });
      continue;
    }
    const clean = stripNoise(code, lang);
    const defs = extractDefs(clean, lang);
    analyzed.push({
      rel: relPosix,
      lang,
      loc: code.split("\n").length,
      defs,
      imports: extractImports(stripNoise(code, lang, true), lang),
      clean,
    });
  }

  const fileSet = new Set(analyzed.map((f) => f.rel));

  // --- Índice nombre → definiciones
  const index = new Map();
  for (const file of analyzed) {
    for (const def of file.defs) {
      if (!index.has(def.name)) index.set(def.name, []);
      index.get(def.name).push({ file: file.rel, def });
    }
  }

  // --- 2ª pasada: imports resueltos y llamadas
  const edges = [];
  const edgeKeys = new Map();

  function addEdge(source, target, kind, site, ambiguous) {
    if (!source || !target) return;
    const key = `${kind}|${source}|${target}`;
    let edge = edgeKeys.get(key);
    if (!edge) {
      edge = { source, target, kind, count: 0, sites: [], ambiguous: !!ambiguous };
      edgeKeys.set(key, edge);
      edges.push(edge);
    }
    edge.count++;
    if (ambiguous === false) edge.ambiguous = false;
    if (site && edge.sites.length < 12) edge.sites.push(site);
  }

  for (const file of analyzed) {
    // imports entre archivos del propio proyecto
    file.importedFiles = new Set();
    for (const imp of file.imports) {
      const target = resolveImport(imp.spec, file.rel, fileSet, file.lang);
      if (!target) continue;
      file.importedFiles.add(target);
      addEdge(fileId(file.rel), fileId(target), "import", { file: file.rel, line: imp.line }, false);
    }
  }

  for (const file of analyzed) {
    const localNames = new Set(file.defs.map((d) => d.name));
    for (const call of extractCalls(file.clean, file.lang, file.defs)) {
      const resolved = resolveCall(call, file, localNames, index);
      if (!resolved) continue;
      const source = call.enclosing ? fnId(file.rel, call.enclosing) : fileId(file.rel);
      const target = fnId(resolved.file, call.name);
      if (source === target) continue; // recursión: no aporta al mapa
      addEdge(source, target, "call", { file: file.rel, line: call.line, fn: call.enclosing }, resolved.ambiguous);
    }
  }

  // --- Nodos
  const nodes = [];
  for (const file of analyzed) {
    nodes.push({
      id: fileId(file.rel),
      type: "file",
      label: path.posix.basename(file.rel),
      file: file.rel,
      dir: path.posix.dirname(file.rel) === "." ? "" : path.posix.dirname(file.rel),
      lang: file.lang.id,
      loc: file.loc,
      defs: file.defs.length,
    });
    for (const def of file.defs) {
      nodes.push({
        id: fnId(file.rel, def.name),
        type: "fn",
        label: def.name,
        file: file.rel,
        dir: path.posix.dirname(file.rel) === "." ? "" : path.posix.dirname(file.rel),
        lang: file.lang.id,
        kind: def.kind,
        line: def.line,
        endLine: def.endLine,
      });
    }
  }

  // Nodos de archivos sin análisis (config, estilos, datos): el mapa enseña el
  // proyecto entero, aunque de estos no salgan aristas.
  for (const other of skipped) {
    nodes.push({
      id: fileId(other.rel),
      type: "file",
      label: path.posix.basename(other.rel),
      file: other.rel,
      dir: path.posix.dirname(other.rel) === "." ? "" : path.posix.dirname(other.rel),
      lang: other.lang || "otro",
      loc: 0,
      defs: 0,
      opaque: true,
    });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const clean = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  return {
    root,
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    stats: {
      files: rels.length,
      analyzed: analyzed.length,
      functions: nodes.filter((n) => n.type === "fn").length,
      calls: clean.filter((e) => e.kind === "call").length,
      imports: clean.filter((e) => e.kind === "import").length,
      truncated: rels.length >= MAX_FILES,
      languages: [...new Set(analyzed.map((f) => f.lang.id))],
    },
    nodes,
    edges: clean,
  };
}

// Orden de preferencia: misma archivo → archivo importado → único candidato.
// Si quedan varios candidatos sin desempate, se elige el primero y se marca
// como ambigua para que el panel la dibuje punteada.
function resolveCall(call, file, localNames, index) {
  const candidates = index.get(call.name);
  if (!candidates || candidates.length === 0) return null;

  if (localNames.has(call.name)) return { file: file.rel, ambiguous: false };

  const imported = candidates.filter((c) => file.importedFiles.has(c.file));
  if (imported.length === 1) return { file: imported[0].file, ambiguous: false };
  if (imported.length > 1) return { file: imported[0].file, ambiguous: true };

  if (candidates.length === 1) return { file: candidates[0].file, ambiguous: false };
  return { file: candidates[0].file, ambiguous: true };
}

module.exports = {
  LANGS,
  buildGraph,
  walk,
  langForFile,
  stripNoise,
  extractDefs,
  extractImports,
  extractCalls,
  resolveImport,
  resolveCall,
};
