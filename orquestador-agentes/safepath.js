// Contención de rutas para la pestaña Editor.
//
// El editor puede leer y escribir archivos, así que sin esto un POST a
// /api/files/write sería un "escribe donde quieras" en el Mac. La regla: la
// ruta real tiene que caer dentro de alguna carpeta ya registrada en Proyectos.
//
// Módulo aparte y sin estado para poder probarlo (ver test/safepath.test.js).

const fs = require("fs");
const os = require("os");
const path = require("path");

// Carpetas que el árbol no muestra: ruido, y en el caso de .git, credenciales.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".pnpm-store",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Expande ~ y devuelve una ruta absoluta. No toca el disco.
function expandPath(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  const expanded = p.trim().replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(expanded);
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

// ¿'child' está dentro de 'root'? Se compara por segmentos con path.relative y
// no con startsWith: '/a/proyecto-2' no debe colarse por ser prefijo textual
// de '/a/proyecto'.
function isInside(root, child) {
  if (root === child) return true;
  const rel = path.relative(root, child);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Alguna carpeta del nombre es .git, node_modules y compañía.
function hasSkippedSegment(root, target) {
  return path
    .relative(root, target)
    .split(path.sep)
    .some((seg) => SKIP_DIRS.has(seg));
}

// Devuelve la ruta real si cae dentro de alguna raíz, o null.
// Los symlinks se resuelven antes de comparar: un enlace no puede sacarte del
// proyecto. Un archivo que todavía no existe se valida por su carpeta padre,
// que es lo que hace falta para guardar uno nuevo.
function resolveInsideRoots(p, roots, { allowSkipped = false } = {}) {
  const abs = expandPath(p);
  if (!abs) return null;

  let real = realOrNull(abs);
  if (!real) {
    const parent = realOrNull(path.dirname(abs));
    if (!parent) return null;
    real = path.join(parent, path.basename(abs));
  }

  for (const root of roots) {
    const realRoot = realOrNull(root);
    if (!realRoot || !isInside(realRoot, real)) continue;
    if (!allowSkipped && hasSkippedSegment(realRoot, real)) return null;
    return real;
  }
  return null;
}

// Un archivo con bytes nulos al principio no es texto: Monaco no lo puede abrir.
function looksBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

module.exports = {
  SKIP_DIRS,
  MAX_FILE_BYTES,
  expandPath,
  realOrNull,
  isInside,
  hasSkippedSegment,
  resolveInsideRoots,
  looksBinary,
};
