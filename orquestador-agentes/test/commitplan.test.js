// Tests del plan de commits. Se ejecutan con:  node --test test/commitplan.test.js
// Sin dependencias: runner integrado de Node.

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCommitPlan, normalizeCommits, MAX_MESSAGE } = require("../commitplan");

test("un bloque completo se lee entero, con el cuerpo del mensaje", () => {
  const text = `
COMMIT: repinta el panel
ARCHIVOS:
public/styles.css
public/index.html
MENSAJE:
Repinta el panel con la paleta oro y teal

El cuerpo va aparte del asunto.
FIN`;
  assert.deepEqual(parseCommitPlan(text), [
    {
      title: "repinta el panel",
      files: ["public/styles.css", "public/index.html"],
      message: "Repinta el panel con la paleta oro y teal\n\nEl cuerpo va aparte del asunto.",
    },
  ]);
});

test("sin FIN de por medio, un COMMIT nuevo cierra el anterior", () => {
  const text = `
COMMIT: tarea uno
ARCHIVOS:
a.js
MENSAJE:
Haz algo
COMMIT: tarea dos
ARCHIVOS:
b.js
MENSAJE:
Haz otra cosa`;
  const plan = parseCommitPlan(text);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { title: "tarea uno", files: ["a.js"], message: "Haz algo" });
  assert.deepEqual(plan[1], { title: "tarea dos", files: ["b.js"], message: "Haz otra cosa" });
});

test("bloques numerados y con el valor en la misma línea del encabezado", () => {
  const text = `
COMMIT 2: arranque
ARCHIVOS: a.js, b.js
MENSAJE: Mensaje de arranque
FIN`;
  assert.deepEqual(parseCommitPlan(text), [
    { title: "arranque", files: ["a.js", "b.js"], message: "Mensaje de arranque" },
  ]);
});

test("las viñetas de la lista de archivos se quitan", () => {
  const text = `
COMMIT: estilos
ARCHIVOS:
- a.css
* b.css
• c.css
MENSAJE: Ajusta las clases
FIN`;
  assert.deepEqual(parseCommitPlan(text)[0].files, ["a.css", "b.css", "c.css"]);
});

test("un plan envuelto en un bloque de código se lee igual", () => {
  const text = "```\nCOMMIT: prueba\nARCHIVOS: a.js\nMENSAJE: Un mensaje\nFIN\n```";
  assert.deepEqual(parseCommitPlan(text), [
    { title: "prueba", files: ["a.js"], message: "Un mensaje" },
  ]);
});

test("sin título, el título es la primera línea del mensaje", () => {
  const text = `
COMMIT:
ARCHIVOS: a.js
MENSAJE:
Guarda el plan de commits por repositorio

Y el cuerpo no cuenta para el título.
FIN`;
  assert.equal(parseCommitPlan(text)[0].title, "Guarda el plan de commits por repositorio");
});

// Estas rutas acaban en `git add`: las que git podría leer como otra cosa no
// entran, aunque el modelo las escriba.
test("las rutas peligrosas se descartan y el resto del bloque sobrevive", () => {
  const text = `
COMMIT: rutas
ARCHIVOS:
/etc/passwd
../fuera.js
-fuerza
src/dentro.js
MENSAJE: Solo la ruta buena
FIN`;
  const plan = parseCommitPlan(text);
  assert.deepEqual(plan[0].files, ["src/dentro.js"]);
  assert.equal(plan[0].message, "Solo la ruta buena");
});

test("un archivo repetido se queda en uno", () => {
  const text = `
COMMIT: repetidos
ARCHIVOS:
a.js
a.js
b.js
MENSAJE: Un mensaje
FIN`;
  assert.deepEqual(parseCommitPlan(text)[0].files, ["a.js", "b.js"]);
});

test("un bloque sin mensaje ni archivos no es un commit", () => {
  assert.deepEqual(parseCommitPlan("COMMIT: vacío\nFIN"), []);
});

test("texto vacío o sin bloques da un plan vacío", () => {
  assert.deepEqual(parseCommitPlan(""), []);
  assert.deepEqual(parseCommitPlan(null), []);
  assert.deepEqual(parseCommitPlan("Aquí no hay ningún plan, solo prosa."), []);
});

test("normalizeCommits recorta el mensaje y tira lo que no es un commit", () => {
  const largo = "a".repeat(MAX_MESSAGE + 500);
  const out = normalizeCommits([
    null,
    "COMMIT: esto es una cadena",
    { files: ["a.js"], message: largo },
    { title: "sin nada", files: [], message: "" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].message.length, MAX_MESSAGE);
  assert.deepEqual(out[0].files, ["a.js"]);
});

test("normalizeCommits acepta el plan ya en JSON y limpia sus rutas", () => {
  const out = normalizeCommits([
    { title: "  con espacios  ", files: [" src/a.js ", "../b.js", ""], message: " Un mensaje " },
  ]);
  assert.deepEqual(out, [{ title: "con espacios", files: ["src/a.js"], message: "Un mensaje" }]);
});
