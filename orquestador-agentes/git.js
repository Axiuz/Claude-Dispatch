// Estado de Git de un proyecto y las operaciones que la tarjeta del carril
// derecho deja lanzar: cambiar de rama, preparar archivos, commitear, subir y
// traer. Lo que no está aquí (rebase, resolver conflictos, tags) sigue siendo
// cosa de la terminal.
//
// Todo pasa por execFile con argumentos fijos, nunca por una cadena para la
// shell, porque tanto la ruta como el nombre de rama vienen de fuera. Lo que
// se puede probar sin repo —parseos y construcción de argumentos— va en
// funciones puras (ver test/git.test.js).

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const MAX_COMMITS = 30;
const GIT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 4 * 1024 * 1024;
const NET_TIMEOUT_MS = 60000;
const LOCK_RETRY_MS = 300;

// Nada puede quedarse esperando a que alguien escriba: un push que pide
// credenciales o un pull que abre el editor colgarían el proceso hasta el
// timeout. Con esto fallan rápido y con un mensaje que se puede enseñar.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat" };

// Separadores del formato de `git log`: 0x1f entre campos, 0x1e entre commits.
// Son caracteres de control, así que no pueden aparecer en un mensaje normal.
const FIELD = "\x1f";
const RECORD = "\x1e";
const LOG_FORMAT = ["%H", "%h", "%an", "%aI", "%s"].join(FIELD) + RECORD;

// Letra de porcelain → qué le pasó al archivo. La misma letra en la columna del
// índice o en la del árbol de trabajo significa lo mismo; lo que cambia es si
// está en el stage.
const LETTERS = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "conflict",
  "?": "untracked",
  "!": "ignored",
};

// "## main...origin/main [ahead 2, behind 1]" y sus variantes.
function parseBranchLine(line) {
  const info = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false };
  const rest = line.replace(/^## /, "");

  if (rest.startsWith("HEAD (no branch)")) {
    info.detached = true;
    return info;
  }

  // Repo recién creado: "No commits yet on main"
  const noCommits = rest.match(/^No commits yet on (.+?)(?: \[|$)/);
  if (noCommits) {
    info.branch = noCommits[1].trim();
    return info;
  }

  const [names, tracking] = splitOnce(rest, " [");
  const [branch, upstream] = splitOnce(names, "...");
  info.branch = branch.trim() || null;
  info.upstream = upstream ? upstream.trim() : null;

  if (tracking) {
    const t = parseTrack(tracking);
    info.ahead = t.ahead;
    info.behind = t.behind;
  }
  return info;
}

// "[ahead 2, behind 1]" o "[gone]": lo que sale tanto de la cabecera de status
// como de %(upstream:track) en for-each-ref.
function parseTrack(text) {
  const t = String(text || "");
  const ahead = t.match(/ahead (\d+)/);
  const behind = t.match(/behind (\d+)/);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: t.includes("gone") };
}

function splitOnce(text, sep) {
  const i = text.indexOf(sep);
  return i === -1 ? [text, null] : [text.slice(0, i), text.slice(i + sep.length)];
}

// Salida de `git status --porcelain=v1 -b -z`: las entradas van separadas por
// NUL, no por salto de línea, para que un nombre de archivo con espacios o
// acentos no rompa nada. Un rename ocupa dos entradas: primero el destino y
// justo después el origen.
function parseStatus(stdout) {
  const parts = String(stdout || "").split("\0");
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [] };
  let pendingRename = null;

  for (const part of parts) {
    if (!part) continue;

    if (pendingRename) {
      pendingRename.from = part;
      pendingRename = null;
      continue;
    }

    if (part.startsWith("## ")) {
      Object.assign(result, parseBranchLine(part));
      continue;
    }
    if (part.length < 4) continue;

    const index = part[0];
    const work = part[1];
    const file = part.slice(3);
    const entry = {
      path: file,
      name: path.basename(file),
      dir: path.dirname(file) === "." ? "" : path.dirname(file),
      index,
      work,
      staged: index !== " " && index !== "?",
      untracked: index === "?" && work === "?",
      conflict: index === "U" || work === "U" || (index === "A" && work === "A") || (index === "D" && work === "D"),
      // La letra que se enseña: manda la del árbol de trabajo si hay cambio sin
      // stagear, que es lo que el usuario acaba de tocar.
      letter: (work !== " " ? work : index).replace("?", "U"),
      kind: LETTERS[work !== " " ? work : index] || "modified",
      from: null,
    };
    result.files.push(entry);
    if (index === "R" || index === "C") pendingRename = entry;
  }

  result.files.sort((a, b) => a.path.localeCompare(b.path, "es"));
  return result;
}

// Salida de `git log --format=...` con los separadores de arriba.
function parseLog(stdout) {
  return String(stdout || "")
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\n/, ""))
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [hash, short, author, date, ...subject] = chunk.split(FIELD);
      return {
        hash,
        short,
        author,
        date,
        subject: subject.join(FIELD),
      };
    })
    .filter((c) => c.hash);
}

// Los `ahead` primeros commits son los que todavía no están en el remoto: son
// los que en VS Code salen con la flecha de subir.
function markUnpushed(commits, ahead) {
  return commits.map((c, i) => ({ ...c, unpushed: i < ahead }));
}

// La carpeta abierta puede ser una subcarpeta del repo (aquí mismo pasa: el
// paquete vive dentro del repositorio). Se sube hasta encontrar .git, con tope
// para no recorrer medio disco si no hay ninguno.
function findRepoRoot(dir, { maxUp = 8 } = {}) {
  let current = dir;
  for (let i = 0; i <= maxUp; i++) {
    try {
      if (fs.existsSync(path.join(current, ".git"))) return current;
    } catch (_) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

const isRepo = (dir) => findRepoRoot(dir) !== null;

// --no-optional-locks: `git status` refresca el índice y para eso toma
// .git/index.lock. El panel lo llama cada 5 s, así que sin esta bandera el
// sondeo le quita el lock al `git add` del plan de commits y el commit muere con
// "Unable to create index.lock". Con ella, leer no bloquea nunca.
function git(dir, args, { timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      { cwd: dir, timeout, maxBuffer: MAX_BUFFER, encoding: "utf-8", windowsHide: true, env: GIT_ENV },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

const LOCK_ERROR = /\.lock['"]?:?\s*File exists|Unable to create .*\.lock/i;

function isLockError(output) {
  return LOCK_ERROR.test(String(output || ""));
}

// Una escritura a la vez por repositorio. El lock de git es del repo entero, así
// que dos operaciones nuestras en paralelo —el sondeo que repinta, dos pestañas,
// un doble clic en el plan— se pisarían igual que se pisan dos `git add`.
const writeLocks = new Map();

function serialize(key, fn) {
  const prev = writeLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  writeLocks.set(key, tail);
  tail.then(() => {
    if (writeLocks.get(key) === tail) writeLocks.delete(key);
  });
  return run;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Como `git()` pero sin lanzar, para las operaciones de escritura: ahí lo que
// git escribe en stderr es justo lo que hay que enseñar, falle o no.
function execGit(dir, args, timeout) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: dir, timeout, maxBuffer: MAX_BUFFER, encoding: "utf-8", windowsHide: true, env: GIT_ENV },
      (err, stdout, stderr) => {
        const output = [stdout, stderr]
          .map((part) => String(part || "").trim())
          .filter(Boolean)
          .join("\n");
        resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || ""), output: output || (err ? err.message : "") });
      }
    );
  });
}

function runGit(dir, args, { timeout = GIT_TIMEOUT_MS } = {}) {
  return serialize(findRepoRoot(dir) || dir, async () => {
    const first = await execGit(dir, args, timeout);
    // El lock puede ser de un git de fuera —la terminal, Claude Code— y esos no
    // pasan por nuestra cola. Suelen durar milisegundos: un reintento ahorra el
    // fallo sin esconder un lock de verdad atascado.
    if (first.ok || !isLockError(first.output)) return first;
    await wait(LOCK_RETRY_MS);
    return execGit(dir, args, timeout);
  });
}

// Estado completo para la tarjeta. No lanza: si git falla, devuelve el motivo.
async function readRepo(dir, { limit = MAX_COMMITS } = {}) {
  const root = findRepoRoot(dir);
  if (!root) return { path: dir, root: null, repo: false, error: null };

  try {
    const [statusOut, logOut] = await Promise.all([
      git(root, ["status", "--porcelain=v1", "-b", "-z"]),
      git(root, ["log", `--max-count=${limit}`, `--format=${LOG_FORMAT}`]),
    ]);
    const status = parseStatus(statusOut);
    return {
      path: dir,
      root,
      repo: true,
      error: null,
      ...status,
      commits: markUnpushed(parseLog(logOut), status.ahead),
      readAt: new Date().toISOString(),
    };
  } catch (err) {
    return { path: dir, root, repo: true, error: err.message, files: [], commits: [] };
  }
}

// ================= Ramas =================
// `for-each-ref` da en una pasada lo que la cabecera de `status` solo da de la
// rama actual: upstream y ahead/behind de todas. El refname completo va delante
// porque es lo único que distingue una rama local de una remota: la versión
// corta de refs/remotes/origin/main es "origin/main", que también podría ser el
// nombre de una rama local.
const BRANCH_FORMAT = ["%(refname)", "%(refname:short)", "%(upstream:short)", "%(upstream:track)", "%(HEAD)", "%(committerdate:iso8601)"].join(FIELD);

function parseBranches(stdout) {
  const local = [];
  const remoteAll = [];

  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const [ref, short, upstream, track, head, date] = line.split(FIELD);
    if (!ref || !short) continue;

    if (ref.startsWith("refs/heads/")) {
      const t = parseTrack(track);
      local.push({
        name: short,
        upstream: upstream || null,
        ahead: t.ahead,
        behind: t.behind,
        gone: t.gone,
        current: head === "*",
        date: date || null,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      // origin/HEAD es un puntero simbólico a la rama por defecto, no una rama
      // a la que uno se cambie
      if (short.endsWith("/HEAD")) continue;
      remoteAll.push({ name: short, shortName: short.split("/").slice(1).join("/"), date: date || null });
    }
  }

  // Una remota que ya tiene copia local no se ofrece: para eso está la local
  const locals = new Set(local.map((b) => b.name));
  return {
    local,
    remote: remoteAll.filter((b) => b.shortName && !locals.has(b.shortName)),
    current: local.find((b) => b.current)?.name || null,
  };
}

// Las reglas de git-check-ref-format que importan aquí, para poder avisar antes
// de lanzar el proceso. La primera es la de seguridad: `execFile` impide la
// inyección de shell, pero un nombre que empiece por "-" lo leería git como una
// bandera suya.
const BAD_BRANCH_CHARS = /[\s~^:?*[\\\x00-\x1f\x7f]/;

function branchNameError(name) {
  const n = String(name || "").trim();
  if (!n) return "Escribe un nombre de rama";
  if (n.startsWith("-")) return "Un nombre de rama no puede empezar por '-'";
  if (n === "@") return "'@' no es un nombre de rama válido";
  if (n.startsWith("/") || n.endsWith("/")) return "Un nombre de rama no puede empezar ni terminar con '/'";
  if (n.includes("//")) return "Un nombre de rama no puede llevar '//'";
  if (n.includes("..")) return "Un nombre de rama no puede llevar '..'";
  if (n.includes("@{")) return "Un nombre de rama no puede llevar '@{'";
  if (n.endsWith(".") || n.endsWith(".lock")) return "Un nombre de rama no puede terminar en '.' ni en '.lock'";
  if (BAD_BRANCH_CHARS.test(n)) return "Un nombre de rama no puede llevar espacios ni ~ ^ : ? * [ \\";
  if (n.length > 255) return "El nombre de rama es demasiado largo";
  return null;
}

// Una ruta de archivo llega del panel: se exige relativa a la raíz del repo y
// sin "..", y tampoco puede empezar por "-" por lo mismo que las ramas.
function relPathError(p) {
  const s = String(p || "");
  if (!s) return "Ruta vacía";
  if (s.startsWith("/") || s.startsWith("-")) return `Ruta no válida: ${s}`;
  if (s.split("/").includes("..")) return `Ruta no válida: ${s}`;
  return null;
}

// ================= Argumentos (puros, para poder probarlos sin repo) =================
function commitArgs({ message, amend = false, all = false } = {}) {
  const args = ["commit"];
  if (all) args.push("-a");
  if (amend) args.push("--amend");
  const msg = String(message || "").trim();
  if (msg) args.push("-m", msg);
  // Rehacer el commit sin escribir mensaje conserva el que ya tenía
  else if (amend) args.push("--no-edit");
  return args;
}

function checkoutArgs({ branch, create = false, track = false } = {}) {
  const name = String(branch || "").trim();
  if (create) return ["switch", "-c", name];
  // `switch --track origin/x` crea la local "x" siguiendo a la remota
  if (track) return ["switch", "--track", name];
  return ["switch", name];
}

// ================= Escritura =================
// Todas devuelven {ok, output} y ninguna lanza. El texto de git se pasa tal cual
// al panel: "Your local changes would be overwritten…" explica el fallo mejor
// que cualquier mensaje que inventemos.
const notRepo = () => ({ ok: false, output: "Esta carpeta no está en un repositorio Git" });

async function listBranches(dir) {
  const root = findRepoRoot(dir);
  if (!root) return { repo: false, root: null, error: null, local: [], remote: [], current: null };
  try {
    const out = await git(root, ["for-each-ref", "--sort=-committerdate", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes"]);
    return { repo: true, root, error: null, ...parseBranches(out) };
  } catch (err) {
    return { repo: true, root, error: err.message, local: [], remote: [], current: null };
  }
}

async function checkout(dir, { branch, create = false, track = false } = {}) {
  const root = findRepoRoot(dir);
  if (!root) return notRepo();
  const bad = branchNameError(branch);
  if (bad) return { ok: false, output: bad };
  return runGit(root, checkoutArgs({ branch, create, track }));
}

async function stage(dir, { files = [], all = false } = {}) {
  const root = findRepoRoot(dir);
  if (!root) return notRepo();
  if (all) return runGit(root, ["add", "-A", "--"]);
  const bad = files.map(relPathError).find(Boolean);
  if (bad) return { ok: false, output: bad };
  if (!files.length) return { ok: false, output: "No hay archivos que preparar" };
  return runGit(root, ["add", "--", ...files]);
}

async function unstage(dir, { files = [], all = false } = {}) {
  const root = findRepoRoot(dir);
  if (!root) return notRepo();
  const bad = files.map(relPathError).find(Boolean);
  if (bad) return { ok: false, output: bad };
  if (!all && !files.length) return { ok: false, output: "No hay archivos que quitar" };
  const paths = all ? ["."] : files;
  // En un repo sin ningún commit no hay HEAD contra el que restaurar: ahí lo que
  // saca un archivo del stage es `rm --cached`.
  const hasHead = (await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
  if (!hasHead) return runGit(root, ["rm", "--cached", "-r", "--", ...paths]);
  return runGit(root, ["restore", "--staged", "--", ...paths]);
}

async function commit(dir, { message, amend = false, all = false } = {}) {
  const root = findRepoRoot(dir);
  if (!root) return notRepo();
  const msg = String(message || "").trim();
  if (!msg && !amend) return { ok: false, output: "El mensaje del commit no puede estar vacío" };
  return runGit(root, commitArgs({ message: msg, amend, all }));
}

// La rama actual y a qué sigue, si sigue a algo. En HEAD suelto no hay rama.
async function headInfo(root) {
  const head = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.ok ? head.stdout.trim() : "";
  const up = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  return { branch: branch && branch !== "HEAD" ? branch : null, upstream: up.ok ? up.stdout.trim() : null };
}

async function push(dir) {
  const root = findRepoRoot(dir);
  if (!root) return notRepo();
  const { branch, upstream } = await headInfo(root);
  if (!branch) return { ok: false, output: "No estás en una rama: no hay nada que subir" };
  // Sin upstream, la primera subida lo deja puesto, igual que hace VS Code
  const args = upstream ? ["push"] : ["push", "--set-upstream", "origin", branch];
  return runGit(root, args, { timeout: NET_TIMEOUT_MS });
}

async function pull(dir) {
  const root = findRepoRoot(dir);
  if (!root) return notRepo();
  return runGit(root, ["pull", "--no-edit"], { timeout: NET_TIMEOUT_MS });
}

// Sync = traer y luego subir. Si el pull falla (un conflicto, por ejemplo) no se
// sube nada: eso se resuelve en la terminal. Una rama que todavía no sigue a
// ninguna remota no tiene de dónde traer: ahí sync es publicarla, como en VS Code.
async function sync(dir) {
  const root = findRepoRoot(dir);
  if (!root) return notRepo();
  const { upstream } = await headInfo(root);
  if (!upstream) return push(dir);
  const down = await pull(dir);
  if (!down.ok) return down;
  const up = await push(dir);
  return { ok: up.ok, output: [down.output, up.output].filter(Boolean).join("\n") };
}

module.exports = {
  // parseo puro
  parseBranchLine,
  parseTrack,
  parseStatus,
  parseLog,
  parseBranches,
  markUnpushed,
  branchNameError,
  relPathError,
  isLockError,
  commitArgs,
  checkoutArgs,
  // lectura
  readRepo,
  listBranches,
  isRepo,
  findRepoRoot,
  // escritura
  checkout,
  stage,
  unstage,
  commit,
  push,
  pull,
  sync,
  LETTERS,
  MAX_COMMITS,
};
