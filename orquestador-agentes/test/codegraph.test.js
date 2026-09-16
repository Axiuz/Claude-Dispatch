// Tests del escáner de código. Se ejecutan con:  node --test test/codegraph.test.js
// Sin dependencias: runner integrado de Node.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cg = require("../codegraph");
const js = cg.langForFile("x.js");
const py = cg.langForFile("x.py");

test("los comentarios desaparecen pero el número de líneas no cambia", () => {
  const code = ["// cabecera", "const a = 1;", "/* bloque", "   sigue */", "const b = 2;"].join("\n");
  const clean = cg.stripNoise(code, js);
  assert.equal(clean.split("\n").length, code.split("\n").length);
  assert.ok(!clean.includes("cabecera"));
  assert.ok(!clean.includes("bloque"));
  assert.ok(clean.includes("const a = 1;"));
});

test("el contenido de una cadena se borra, salvo con keepStrings", () => {
  const code = 'const ruta = "./modulo";';
  assert.ok(!cg.stripNoise(code, js).includes("./modulo"));
  assert.ok(cg.stripNoise(code, js, true).includes("./modulo"));
});

test("un apóstrofo suelto no se come el resto del archivo", () => {
  const code = ['const msg = "no está";', "// mañana, don't panic", "function despues() {}"].join("\n");
  const defs = cg.extractDefs(cg.stripNoise(code, js), js);
  assert.deepEqual(defs.map((d) => d.name), ["despues"]);
});

test("una expresión regular con comillas no rompe el análisis", () => {
  const code = ["const q = str.replace(/'/g, \"-\");", "function siguiente() {}"].join("\n");
  const defs = cg.extractDefs(cg.stripNoise(code, js), js);
  assert.deepEqual(defs.map((d) => d.name), ["siguiente"]);
});

test("extractDefs reconoce function, arrow y class con su línea", () => {
  const code = [
    "function uno() {", // 1
    "  return 1;",
    "}",
    "const dos = (x) => {", // 4
    "  return x;",
    "};",
    "class Tres {}", // 7
  ].join("\n");
  const defs = cg.extractDefs(cg.stripNoise(code, js), js);
  assert.deepEqual(
    defs.map((d) => [d.name, d.kind, d.line]),
    [["uno", "function", 1], ["dos", "arrow", 4], ["Tres", "class", 7]]
  );
});

test("endLine cubre el cuerpo con llaves y se queda en la línea si es de una sola", () => {
  const code = ["function larga() {", "  if (true) {", "    return 1;", "  }", "}", "const corta = (x) => x * 2;"].join("\n");
  const defs = cg.extractDefs(cg.stripNoise(code, js), js);
  const larga = defs.find((d) => d.name === "larga");
  const corta = defs.find((d) => d.name === "corta");
  assert.equal(larga.endLine, 5);
  assert.equal(corta.line, 6);
  assert.equal(corta.endLine, 6);
});

test("en Python el cuerpo se delimita por indentación", () => {
  const code = ["def uno():", "    return 1", "", "def dos():", "    return 2"].join("\n");
  const defs = cg.extractDefs(cg.stripNoise(code, py), py);
  assert.equal(defs[0].endLine, 3);
  assert.equal(defs[1].line, 4);
});

test("extractImports encuentra import y require con su línea", () => {
  const code = ['import algo from "./x";', 'const y = require("./y");'].join("\n");
  const imports = cg.extractImports(cg.stripNoise(code, js, true), js);
  assert.deepEqual(imports, [{ spec: "./x", line: 1 }, { spec: "./y", line: 2 }]);
});

test("extractCalls sitúa la llamada dentro de su función e ignora if/for", () => {
  const code = ["function padre() {", "  if (true) {", "    hijo();", "  }", "}", "function hijo() {}"].join("\n");
  const clean = cg.stripNoise(code, js);
  const defs = cg.extractDefs(clean, js);
  const calls = cg.extractCalls(clean, js, defs);
  assert.deepEqual(calls.map((c) => [c.name, c.line, c.enclosing]), [["hijo", 3, "padre"]]);
});

test("resolveImport resuelve lo relativo y descarta los paquetes externos", () => {
  const files = new Set(["src/app.js", "src/utils.js"]);
  assert.equal(cg.resolveImport("./utils", "src/app.js", files, js), "src/utils.js");
  assert.equal(cg.resolveImport("express", "src/app.js", files, js), null);
});

test("resolveImport entiende los imports con puntos de Python", () => {
  const files = new Set(["src/main.py", "src/utils.py"]);
  assert.equal(cg.resolveImport(".utils", "src/main.py", files, py), "src/utils.py");
});

test("buildGraph devuelve nodos de función y aristas de import", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-"));
  try {
    fs.writeFileSync(path.join(dir, "utils.js"), "function suma(a, b) {\n  return a + b;\n}\nmodule.exports = { suma };\n");
    fs.writeFileSync(path.join(dir, "app.js"), 'const { suma } = require("./utils");\n\nfunction total() {\n  return suma(1, 2);\n}\n');

    const graph = cg.buildGraph(dir);
    const suma = graph.nodes.find((n) => n.id === "fn:utils.js#suma");
    assert.ok(suma, "debería existir el nodo de la función suma");
    assert.equal(suma.line, 1);

    const imports = graph.edges.filter((e) => e.kind === "import");
    assert.deepEqual(imports.map((e) => [e.source, e.target]), [["f:app.js", "f:utils.js"]]);

    const llamada = graph.edges.find((e) => e.kind === "call" && e.target === "fn:utils.js#suma");
    assert.ok(llamada, "la llamada a suma debería estar registrada");
    assert.equal(llamada.source, "fn:app.js#total");
    assert.equal(llamada.ambiguous, false);
    assert.equal(graph.stats.analyzed, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("walk ignora node_modules y las carpetas ocultas", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-walk-"));
  try {
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, "node_modules", "lib.js"), "function x() {}\n");
    fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(dir, "visible.js"), "function y() {}\n");
    assert.deepEqual(cg.walk(dir), ["visible.js"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
