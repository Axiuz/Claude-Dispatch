// Tests de la contención de rutas del editor. Se ejecutan con:
//   node --test test/safepath.test.js
// Sin dependencias: runner integrado de Node.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sp = require("../safepath");

// Un proyecto de mentira en un temporal, con un symlink que apunta fuera
function makeProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "safepath-"));
  const root = path.join(base, "proyecto");
  const fuera = path.join(base, "fuera");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "express"), { recursive: true });
  fs.mkdirSync(fuera, { recursive: true });

  fs.writeFileSync(path.join(root, "src", "app.js"), "const a = 1;\n");
  fs.writeFileSync(path.join(root, "node_modules", "express", "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(fuera, "secreto.txt"), "no mirar\n");
  fs.symlinkSync(path.join(fuera, "secreto.txt"), path.join(root, "atajo.txt"));
  return { base, root, fuera };
}

test("isInside distingue dentro, fuera y la raíz consigo misma", () => {
  assert.equal(sp.isInside("/a/proyecto", "/a/proyecto"), true);
  assert.equal(sp.isInside("/a/proyecto", "/a/proyecto/src/app.js"), true);
  assert.equal(sp.isInside("/a/proyecto", "/a/otro/app.js"), false);
  assert.equal(sp.isInside("/a/proyecto", "/a"), false);
});

test("un nombre que empieza igual no cuenta como dentro", () => {
  // El fallo clásico de comparar con startsWith
  assert.equal(sp.isInside("/a/proyecto", "/a/proyecto-2/app.js"), false);
  assert.equal(sp.isInside("/a/proyecto", "/a/proyectos/app.js"), false);
});

test("hasSkippedSegment detecta node_modules y .git en cualquier nivel", () => {
  assert.equal(sp.hasSkippedSegment("/a", "/a/node_modules/express/index.js"), true);
  assert.equal(sp.hasSkippedSegment("/a", "/a/src/.git/config"), true);
  assert.equal(sp.hasSkippedSegment("/a", "/a/dist/bundle.js"), true);
  assert.equal(sp.hasSkippedSegment("/a", "/a/src/app.js"), false);
});

test("looksBinary mira los bytes nulos del principio", () => {
  assert.equal(sp.looksBinary(Buffer.from("const a = 1;\n")), false);
  assert.equal(sp.looksBinary(Buffer.from([0x89, 0x50, 0x00, 0x4e])), true);
  assert.equal(sp.looksBinary(Buffer.alloc(0)), false);
});

test("expandPath resuelve ~ y deja rutas absolutas", () => {
  assert.equal(sp.expandPath("~"), os.homedir());
  assert.equal(sp.expandPath("~/x"), path.join(os.homedir(), "x"));
  assert.equal(sp.expandPath("/a/b/../c"), "/a/c");
  assert.equal(sp.expandPath(""), null);
  assert.equal(sp.expandPath(undefined), null);
});

test("un archivo del proyecto se acepta; uno de fuera, no", (t) => {
  const { base, root, fuera } = makeProject();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const roots = [root];

  assert.ok(sp.resolveInsideRoots(path.join(root, "src", "app.js"), roots));
  assert.equal(sp.resolveInsideRoots(path.join(fuera, "secreto.txt"), roots), null);
  assert.equal(sp.resolveInsideRoots("/etc/passwd", roots), null);
});

test("los .. no sacan del proyecto", (t) => {
  const { base, root } = makeProject();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  assert.equal(sp.resolveInsideRoots(path.join(root, "..", "fuera", "secreto.txt"), [root]), null);
});

test("un symlink que apunta fuera tampoco pasa", (t) => {
  const { base, root } = makeProject();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // atajo.txt vive dentro del proyecto pero su destino real está fuera
  assert.equal(sp.resolveInsideRoots(path.join(root, "atajo.txt"), [root]), null);
});

test("node_modules queda fuera salvo que se pida explícitamente", (t) => {
  const { base, root } = makeProject();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const target = path.join(root, "node_modules", "express", "index.js");

  assert.equal(sp.resolveInsideRoots(target, [root]), null);
  assert.ok(sp.resolveInsideRoots(target, [root], { allowSkipped: true }));
});

test("un archivo que todavía no existe se valida por su carpeta", (t) => {
  const { base, root } = makeProject();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  // hace falta para guardar un archivo nuevo dentro del proyecto
  assert.ok(sp.resolveInsideRoots(path.join(root, "src", "nuevo.js"), [root]));
  // pero no para inventarse uno en una carpeta que no existe
  assert.equal(sp.resolveInsideRoots(path.join(root, "no", "existe", "x.js"), [root]), null);
});

test("sin proyectos registrados no se puede abrir nada", (t) => {
  const { base, root } = makeProject();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  assert.equal(sp.resolveInsideRoots(path.join(root, "src", "app.js"), []), null);
});
