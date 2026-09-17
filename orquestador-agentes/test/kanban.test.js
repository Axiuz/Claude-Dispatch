// Tests de las reglas del tablero. Se ejecutan con:  node --test test/kanban.test.js
// Sin dependencias: runner integrado de Node.

const test = require("node:test");
const assert = require("node:assert/strict");

const { COLUMNS, COLUMN_AFTER_RUN, columnFor, bySort, placeStep } = require("../kanban");

const step = (id, column, sort) => ({ id, column, sort, status: column });

test("las cinco columnas, en su orden, y sin la vieja 'approved'", () => {
  assert.deepEqual(COLUMNS, ["todo", "progress", "review", "done", "errors"]);
});

test("una columna válida se devuelve tal cual", () => {
  COLUMNS.forEach((c) => assert.equal(columnFor(c), c));
});

test("el vocabulario viejo se traduce, que es lo que manda Claude Code", () => {
  assert.equal(columnFor("pending"), "todo");
  assert.equal(columnFor("queued"), "todo");
  assert.equal(columnFor("running"), "progress");
  assert.equal(columnFor("error"), "errors");
  // 'done' ya es una columna, no pasa por la traducción
  assert.equal(columnFor("done"), "done");
});

test("el 'approved' de los tableros guardados aterriza en hecho, no en todo", () => {
  assert.equal(columnFor("approved"), "done");
});

test("un valor desconocido cae al fallback, no rompe el tablero", () => {
  assert.equal(columnFor("inventada"), "todo");
  assert.equal(columnFor(undefined), "todo");
  assert.equal(columnFor(null, "review"), "review");
});

test("placeStep mueve el paso de columna y mantiene status al día", () => {
  const a = step("a", "todo", 1);
  const steps = [a];
  placeStep(steps, a, "review");
  assert.equal(a.column, "review");
  assert.equal(a.status, "review");
});

test("placeStep respeta el índice pedido", () => {
  const a = step("a", "todo", 1);
  const b = step("b", "todo", 2);
  const c = step("c", "progress", 1);
  const steps = [a, b, c];

  placeStep(steps, c, "todo", 1); // entre a y b
  const orden = steps
    .filter((s) => s.column === "todo")
    .sort(bySort)
    .map((s) => s.id);
  assert.deepEqual(orden, ["a", "c", "b"]);
});

test("la columna se renumera desde 1 y sin huecos", () => {
  const a = step("a", "todo", 7);
  const b = step("b", "todo", 40);
  const c = step("c", "review", 1);
  const steps = [a, b, c];

  placeStep(steps, c, "todo", 0);
  const sorts = steps
    .filter((s) => s.column === "todo")
    .sort(bySort)
    .map((s) => s.sort);
  assert.deepEqual(sorts, [1, 2, 3]);
});

test("un índice fuera de rango se recorta en vez de dejar huecos", () => {
  const a = step("a", "todo", 1);
  const b = step("b", "todo", 2);
  const steps = [a, b];

  placeStep(steps, b, "todo", 99);
  assert.deepEqual(steps.sort(bySort).map((s) => s.id), ["a", "b"]);

  placeStep(steps, b, "todo", -5);
  assert.deepEqual(steps.sort(bySort).map((s) => s.id), ["b", "a"]);
});

test("un paso sin sort se ordena por su número de paso", () => {
  const a = { id: "a", column: "todo", order: 3 };
  const b = { id: "b", column: "todo", order: 1 };
  assert.deepEqual([a, b].sort(bySort).map((s) => s.id), ["b", "a"]);
});

test("lo que escribe un agente acaba en revisión, y lo que falla en errores", () => {
  assert.equal(COLUMN_AFTER_RUN.done, "review");
  assert.equal(COLUMN_AFTER_RUN.error, "errors");
  assert.equal(COLUMN_AFTER_RUN.cancelled, "todo");
});

test("placeStep lleva la tarjeta a errores y deja status al día", () => {
  const a = step("a", "review", 1);
  const steps = [a];
  placeStep(steps, a, "errors", 0);
  assert.equal(a.column, "errors");
  assert.equal(a.status, "errors");
  assert.equal(a.sort, 1);
});
