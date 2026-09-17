// Tests del parseo de Git. Se ejecutan con:  node --test test/git.test.js
// Sin dependencias: runner integrado de Node.
//
// Las cadenas de ejemplo son salida literal de `git status --porcelain=v1 -b -z`
// y de `git log --format=...`: dos columnas de estado, entradas separadas por
// NUL y, en el log, 0x1f entre campos y 0x1e entre commits.

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseBranchLine, parseTrack, parseStatus, parseLog, parseBranches, markUnpushed, branchNameError, relPathError, commitArgs, checkoutArgs, isLockError, remoteUrlError, remoteNameError, repoNameError, parseRemotes } = require("../git");

const FIELD = "\x1f";
const RECORD = "\x1e";
const entries = (...lines) => lines.join("\0") + "\0";

// ---- Cabecera de rama ----

test("la rama trae su upstream y los dos contadores", () => {
  const b = parseBranchLine("## main...origin/main [ahead 2, behind 1]");
  assert.equal(b.branch, "main");
  assert.equal(b.upstream, "origin/main");
  assert.equal(b.ahead, 2);
  assert.equal(b.behind, 1);
  assert.equal(b.detached, false);
});

test("una rama sin remoto no tiene upstream ni contadores", () => {
  const b = parseBranchLine("## trabajo-local");
  assert.equal(b.branch, "trabajo-local");
  assert.equal(b.upstream, null);
  assert.equal(b.ahead, 0);
  assert.equal(b.behind, 0);
});

test("solo ahead y solo behind se leen igual", () => {
  assert.deepEqual(
    [parseBranchLine("## main...origin/main [ahead 3]").ahead, parseBranchLine("## main...origin/main [ahead 3]").behind],
    [3, 0]
  );
  assert.deepEqual(
    [parseBranchLine("## main...origin/main [behind 4]").ahead, parseBranchLine("## main...origin/main [behind 4]").behind],
    [0, 4]
  );
});

test("HEAD suelto no es una rama", () => {
  const b = parseBranchLine("## HEAD (no branch)");
  assert.equal(b.detached, true);
  assert.equal(b.branch, null);
});

test("un repo recién creado da el nombre de la rama, aunque no exista todavía", () => {
  const b = parseBranchLine("## No commits yet on main");
  assert.equal(b.branch, "main");
  assert.equal(b.detached, false);
});

// ---- Archivos ----

test("la cabecera del status llega a la respuesta junto con los archivos", () => {
  const st = parseStatus(entries("## main...origin/main [ahead 2, behind 1]", " M CLAUDE.md"));
  assert.equal(st.branch, "main");
  assert.equal(st.ahead, 2);
  assert.equal(st.behind, 1);
  assert.equal(st.files.length, 1);
});

test("un cambio sin stagear manda la letra del árbol de trabajo", () => {
  const [f] = parseStatus(entries(" M CLAUDE.md")).files;
  assert.equal(f.path, "CLAUDE.md");
  assert.equal(f.name, "CLAUDE.md");
  assert.equal(f.dir, "");
  assert.equal(f.letter, "M");
  assert.equal(f.kind, "modified");
  assert.equal(f.staged, false);
});

test("un archivo ya en el índice se marca staged", () => {
  const [f] = parseStatus(entries("M  public/app.js")).files;
  assert.equal(f.dir, "public");
  assert.equal(f.name, "app.js");
  assert.equal(f.staged, true);
  assert.equal(f.letter, "M");
});

test("un archivo nuevo sin seguir sale como U, que es lo que enseña el panel", () => {
  const [f] = parseStatus(entries("?? nuevo.txt")).files;
  assert.equal(f.untracked, true);
  assert.equal(f.staged, false);
  assert.equal(f.letter, "U");
  assert.equal(f.kind, "untracked");
});

test("un borrado y un conflicto se distinguen", () => {
  const { files } = parseStatus(entries(" D viejo.js", "UU conflicto.js"));
  const borrado = files.find((f) => f.path === "viejo.js");
  const conflicto = files.find((f) => f.path === "conflicto.js");
  assert.equal(borrado.kind, "deleted");
  assert.equal(borrado.letter, "D");
  assert.equal(conflicto.conflict, true);
  assert.equal(conflicto.letter, "U");
});

test("un rename ocupa dos entradas y la segunda es el origen, no un archivo más", () => {
  const { files } = parseStatus(entries("R  destino.js", "origen.js", " M otro.js"));
  assert.equal(files.length, 2);
  const renombrado = files.find((f) => f.path === "destino.js");
  assert.equal(renombrado.from, "origen.js");
  assert.equal(renombrado.kind, "renamed");
  assert.equal(renombrado.staged, true);
  // el archivo de después del rename sigue siendo un archivo normal
  assert.ok(files.some((f) => f.path === "otro.js" && f.from === null));
});

test("una salida vacía no rompe nada", () => {
  const st = parseStatus("");
  assert.deepEqual(st.files, []);
  assert.equal(st.branch, null);
});

// ---- Commits ----

const commit = (hash, short, author, date, subject) => [hash, short, author, date, subject].join(FIELD) + RECORD;

test("cada commit se parte en sus cinco campos", () => {
  const log =
    commit("abc123def", "abc123d", "SAUL HERNANDEZ", "2026-09-17T00:28:34-06:00", "Agrega el banco de pruebas") +
    "\n" +
    commit("def4567", "def4567", "SAUL", "2026-09-16T10:00:00-06:00", "Otro commit");
  const commits = parseLog(log);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    hash: "abc123def",
    short: "abc123d",
    author: "SAUL HERNANDEZ",
    date: "2026-09-17T00:28:34-06:00",
    subject: "Agrega el banco de pruebas",
  });
  assert.equal(commits[1].subject, "Otro commit");
});

test("un mensaje con dos puntos o guiones no se parte de más", () => {
  const [c] = parseLog(commit("a1", "a1", "Yo", "2026-09-17T00:00:00-06:00", "Arregla: la cola por modelo - de verdad"));
  assert.equal(c.subject, "Arregla: la cola por modelo - de verdad");
});

test("un repo sin commits devuelve una lista vacía", () => {
  assert.deepEqual(parseLog(""), []);
  assert.deepEqual(parseLog("\n"), []);
});

// ---- Commits sin subir ----

test("los 'ahead' primeros commits son los que faltan por subir", () => {
  const commits = [{ hash: "a" }, { hash: "b" }, { hash: "c" }];
  assert.deepEqual(
    markUnpushed(commits, 2).map((c) => c.unpushed),
    [true, true, false]
  );
});

test("sin nada que subir ningún commit queda marcado", () => {
  const commits = [{ hash: "a" }, { hash: "b" }];
  assert.ok(markUnpushed(commits, 0).every((c) => c.unpushed === false));
});

// ---- Seguimiento del upstream ----

test("parseTrack lee ahead y behind juntos", () => {
  assert.deepEqual(parseTrack("[ahead 2, behind 1]"), { ahead: 2, behind: 1, gone: false });
});

test("parseTrack lee ahead o behind por separado", () => {
  assert.deepEqual(
    [parseTrack("[ahead 3]"), parseTrack("[behind 4]")].map((t) => [t.ahead, t.behind]),
    [
      [3, 0],
      [0, 4],
    ]
  );
});

test("sin seguimiento los dos contadores son cero", () => {
  assert.deepEqual(parseTrack(""), { ahead: 0, behind: 0, gone: false });
});

test("una rama cuyo remoto desapareció viene marcada como 'gone'", () => {
  const t = parseTrack("[gone]");
  assert.equal(t.gone, true);
  assert.deepEqual([t.ahead, t.behind], [0, 0]);
});

// ---- Ramas (for-each-ref) ----
// Cada línea son seis campos separados por 0x1f; el refname completo va delante
// porque es lo único que distingue "refs/heads/x" de "refs/remotes/origin/x".

const branchLine = (ref, short, upstream, track, head, date = "2026-09-17 00:28:34 -0600") =>
  [ref, short, upstream, track, head, date].join(FIELD);

const LOCAL_MAIN = branchLine("refs/heads/main", "main", "origin/main", "[ahead 2]", "*");
const LOCAL_FEAT = branchLine("refs/heads/feat", "feat", "", "", " ");

test("una rama local trae su upstream, sus contadores y si es la actual", () => {
  const { local, current } = parseBranches(LOCAL_MAIN);
  assert.deepEqual(local, [
    {
      name: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 0,
      gone: false,
      current: true,
      date: "2026-09-17 00:28:34 -0600",
    },
  ]);
  assert.equal(current, "main");
});

test("una rama local sin upstream lo deja en null y no es la actual", () => {
  const { local, current } = parseBranches(LOCAL_FEAT);
  assert.equal(local[0].upstream, null);
  assert.equal(local[0].current, false);
  assert.equal(current, null);
});

test("origin/HEAD no es una rama a la que cambiarse", () => {
  const out = parseBranches(branchLine("refs/remotes/origin/HEAD", "origin/HEAD", "", "", " "));
  assert.deepEqual(out.remote, []);
});

test("una remota sin copia local se ofrece, con el nombre sin el remoto delante", () => {
  const out = parseBranches(branchLine("refs/remotes/origin/feat/x", "origin/feat/x", "", "", " "));
  assert.deepEqual(out.remote, [{ name: "origin/feat/x", shortName: "feat/x", date: "2026-09-17 00:28:34 -0600" }]);
});

test("una remota que ya tiene copia local no se repite", () => {
  const out = parseBranches([LOCAL_FEAT, branchLine("refs/remotes/origin/feat", "origin/feat", "", "", " ")].join("\n"));
  assert.equal(out.local.length, 1);
  assert.deepEqual(out.remote, []);
});

test("las ramas salen en el orden en que las dio git", () => {
  const out = parseBranches([LOCAL_MAIN, LOCAL_FEAT].join("\n"));
  assert.deepEqual(out.local.map((b) => b.name), ["main", "feat"]);
});

test("sin ramas, las dos listas quedan vacías", () => {
  const out = parseBranches("");
  assert.deepEqual([out.local, out.remote, out.current], [[], [], null]);
});

// ---- Nombres de rama y rutas ----

test("un nombre de rama corriente pasa", () => {
  assert.equal(branchNameError("feat/algo-2"), null);
});

test("los nombres que git rechazaría se avisan antes de lanzar el proceso", () => {
  for (const malo of ["", "-rf", "con espacio", "a..b", "rama/", "algo.lock", "x~1", "@", "a@{1}", "a//b"]) {
    assert.equal(typeof branchNameError(malo), "string", `debería rechazar ${JSON.stringify(malo)}`);
  }
});

test("una ruta relativa del repo pasa; una absoluta, una con '..' o una que parece bandera, no", () => {
  assert.equal(relPathError("src/app.js"), null);
  for (const mala of ["", "/etc/passwd", "../fuera", "-x"]) {
    assert.equal(typeof relPathError(mala), "string", `debería rechazar ${JSON.stringify(mala)}`);
  }
});

// ---- Argumentos de commit y de cambio de rama ----

test("un commit normal lleva el mensaje recortado", () => {
  assert.deepEqual(commitArgs({ message: "  arregla el parseo  " }), ["commit", "-m", "arregla el parseo"]);
});

test("commitear todo el árbol añade -a delante de --amend", () => {
  assert.deepEqual(commitArgs({ message: "x", all: true, amend: true }), ["commit", "-a", "--amend", "-m", "x"]);
});

test("rehacer el commit sin escribir mensaje conserva el que tenía", () => {
  const args = commitArgs({ amend: true });
  assert.deepEqual(args, ["commit", "--amend", "--no-edit"]);
  assert.ok(!args.includes("-m"));
});

test("cambiar, crear y sacar una remota son tres órdenes distintas", () => {
  assert.deepEqual(checkoutArgs({ branch: "main" }), ["switch", "main"]);
  assert.deepEqual(checkoutArgs({ branch: "nueva", create: true }), ["switch", "-c", "nueva"]);
  assert.deepEqual(checkoutArgs({ branch: "origin/feat", track: true }), ["switch", "--track", "origin/feat"]);
});

test("isLockError reconoce el lock de git y deja pasar lo demás", () => {
  assert.ok(isLockError("fatal: Unable to create '/Users/x/repo/.git/index.lock': File exists."));
  assert.ok(isLockError("Unable to create .git/refs/heads/main.lock"));
  assert.ok(!isLockError("nothing to commit, working tree clean"));
  assert.ok(!isLockError("error: pathspec 'rama' did not match any file(s)"));
  assert.ok(!isLockError(""));
  assert.ok(!isLockError(null));
  assert.ok(!isLockError(undefined));
});

// serialize() no se exporta: es un detalle de runGit(). La copia de aquí tiene
// que seguir igual que la de git.js, y es lo que se prueba.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("serialize no deja que dos operaciones de la misma clave se solapen", async () => {
  const log = [];
  const task = (name) => async () => {
    log.push(`${name}:inicio`);
    await sleep(20);
    log.push(`${name}:fin`);
    return name;
  };

  const [a, b] = await Promise.all([serialize("repo", task("a")), serialize("repo", task("b"))]);

  assert.equal(a, "a");
  assert.equal(b, "b");
  assert.deepEqual(log, ["a:inicio", "a:fin", "b:inicio", "b:fin"]);
});

test("una operación que falla no bloquea la cola de su clave", async () => {
  const fallo = serialize("repo", async () => {
    throw new Error("boom");
  });
  const siguiente = serialize("repo", async () => "sigue");

  await assert.rejects(fallo, /boom/);
  assert.equal(await siguiente, "sigue");
});

test("dos repositorios distintos corren en paralelo", async () => {
  const log = [];
  const task = (name) => async () => {
    log.push(`${name}:inicio`);
    await sleep(20);
    log.push(`${name}:fin`);
  };

  await Promise.all([serialize("uno", task("uno")), serialize("dos", task("dos"))]);

  assert.deepEqual(log, ["uno:inicio", "dos:inicio", "uno:fin", "dos:fin"]);
});

test("la clave se olvida cuando su cola se vacía", async () => {
  await serialize("efímero", async () => "listo");
  await sleep(0);
  assert.equal(writeLocks.has("efímero"), false);
});

// ---- URL de un remoto ----

test("la URL vacía devuelve un mensaje de error", () => {
  assert.equal(remoteUrlError(""), "Escribe la URL del remoto");
});

test("la URL que empieza por '-' se rechaza", () => {
  assert.equal(remoteUrlError("-https://example.com"), "La URL no puede empezar por '-'");
});

test("la URL con espacios o caracteres de control se rechaza", () => {
  assert.equal(remoteUrlError("https://example.com\x01"), "La URL no puede llevar espacios ni caracteres de control");
  assert.equal(remoteUrlError("https://a b"), "La URL no puede llevar espacios ni caracteres de control");
});

test("la URL demasiado larga se rechaza", () => {
  assert.equal(remoteUrlError(`https://example.com/${"a".repeat(2049)}`), "La URL es demasiado larga");
});

test("la forma transporte::dirección se rechaza", () => {
  assert.equal(remoteUrlError("ext::sh"), "No se admiten las URLs de la forma transporte::dirección");
  assert.equal(remoteUrlError("::x"), "No se admiten las URLs de la forma transporte::dirección");
});

test("los esquemas que no son de git se rechazan", () => {
  assert.equal(remoteUrlError("file:///etc/passwd"), "No se admite el esquema 'file': usa https, ssh o git");
  assert.equal(remoteUrlError("ftp://example.com"), "No se admite el esquema 'ftp': usa https, ssh o git");
  assert.equal(remoteUrlError("javascript://x"), "No se admite el esquema 'javascript': usa https, ssh o git");
});

test("las URL de repositorio normales se aceptan", () => {
  assert.equal(remoteUrlError("https://github.com/a/b.git"), null);
  assert.equal(remoteUrlError("HTTPS://github.com/a/b.git"), null);
  assert.equal(remoteUrlError("http://gitea.local/a/b.git"), null);
  assert.equal(remoteUrlError("ssh://git@host/a/b.git"), null);
  assert.equal(remoteUrlError("git://host/a/b.git"), null);
  assert.equal(remoteUrlError("git@github.com:a/b.git"), null);
});

test("lo que no parece una URL de repositorio se rechaza", () => {
  assert.match(remoteUrlError("/Users/yo/repo"), /No parece una URL/);
  assert.match(remoteUrlError("github.com/a/b"), /No parece una URL/);
});

// ---- Nombres de remoto y de repositorio ----

test("el nombre de un remoto solo admite letras, números y . _ -", () => {
  assert.equal(remoteNameError("origin"), null);
  assert.equal(remoteNameError("mi-remoto_2.0"), null);
  assert.match(remoteNameError(""), /Escribe el nombre/);
  assert.match(remoteNameError("-origin"), /letras, números/);
  assert.match(remoteNameError("ori gin"), /letras, números/);
});

test("el nombre de un repositorio admite 'dueño/nombre' pero no '..' ni guion inicial", () => {
  assert.equal(repoNameError("mi-repo"), null);
  assert.equal(repoNameError("Axiuz/mi-repo"), null);
  assert.match(repoNameError("-repo"), /empezar por '-'/);
  assert.match(repoNameError("a..b"), /llevar '\.\.'/);
  assert.match(repoNameError("a b"), /Usa solo letras/);
  assert.match(repoNameError("a/b/c"), /Usa solo letras/);
});

// ---- `git remote -v` ----

test("cada remoto sale una sola vez aunque tenga fetch y push", () => {
  const out = [
    "origin\thttps://github.com/a/b.git (fetch)",
    "origin\thttps://github.com/a/b.git (push)",
    "upstream\tgit@github.com:c/d.git (fetch)",
    "upstream\tgit@github.com:c/d.git (push)",
  ].join("\n");
  assert.deepEqual(parseRemotes(out), [
    { name: "origin", url: "https://github.com/a/b.git" },
    { name: "upstream", url: "git@github.com:c/d.git" },
  ]);
});

test("sin remotos la lista viene vacía", () => {
  assert.deepEqual(parseRemotes(""), []);
  assert.deepEqual(parseRemotes("basura sin formato"), []);
});
