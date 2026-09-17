// Tests de las notas. Se ejecutan con:  node --test test/notes.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeItem, normalizeItems, applyUpdate, pendingCount, pruneProjects, MAX_TEXT, MAX_ITEMS, MAX_PROJECTS } = require("../notes");

test("makeItem con texto normal devuelve ficha con done:false, id y createdAt === updatedAt", () => {
  const result = makeItem("Hola mundo");
  assert.ok(result);
  assert.strictEqual(result.done, false);
  assert.ok(result.id);
  assert.strictEqual(result.createdAt, result.updatedAt);
});

test("makeItem con texto vacío devuelve null", () => {
  const result = makeItem("");
  assert.strictEqual(result, null);
});

test("makeItem con texto de solo espacios devuelve null", () => {
  const result = makeItem("   ");
  assert.strictEqual(result, null);
});

test("makeItem con texto de más de MAX_TEXT se recorta a MAX_TEXT", () => {
  const longText = "a".repeat(MAX_TEXT + 1);
  const result = makeItem(longText);
  assert.ok(result);
  assert.strictEqual(result.text.length, MAX_TEXT);
});

test("normalizeItems con array válido devuelve objetos normalizados", () => {
  const input = [
    { text: "uno", done: true },
    { text: "dos", done: false },
    { text: "tres" },
    { text: "cuatro", id: "123" },
    { text: "cinco", id: "123" }, // repetido
  ];
  const result = normalizeItems(input);
  assert.strictEqual(result.length, 4);
  assert.strictEqual(result[0].text, "uno");
  assert.strictEqual(result[1].text, "dos");
  assert.strictEqual(result[2].text, "tres");
  assert.strictEqual(result[3].text, "cuatro");
  assert.strictEqual(result[0].done, true);
  assert.strictEqual(result[1].done, false);
  assert.strictEqual(result[2].done, false);
  assert.strictEqual(result[3].done, false);
});

test("normalizeItems descarta fichas sin texto", () => {
  const input = [
    { text: "" },
    { text: "uno" },
    { text: null },
    { text: undefined },
    { text: "dos" },
  ];
  const result = normalizeItems(input);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].text, "uno");
  assert.strictEqual(result[1].text, "dos");
});

test("normalizeItems descarta fichas que no son objetos", () => {
  const input = [1, "texto", null, {}, { text: "uno" }];
  const result = normalizeItems(input);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].text, "uno");
});

test("normalizeItems ignora ids repetidos quedándose con la primera", () => {
  const input = [
    { text: "uno", id: "a" },
    { text: "dos", id: "a" },
    { text: "tres", id: "b" },
  ];
  const result = normalizeItems(input);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].text, "uno");
  assert.strictEqual(result[1].text, "tres");
});

test("normalizeItems corta la lista en MAX_ITEMS", () => {
  const input = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ text: `item-${i}` }));
  const result = normalizeItems(input);
  assert.strictEqual(result.length, MAX_ITEMS);
});

test("normalizeItems con algo que no es array devuelve []", () => {
  const result = normalizeItems(null);
  assert.strictEqual(result.length, 0);
});

test("applyUpdate cambia texto y actualiza updatedAt", () => {
  const item = makeItem("original", "2024-01-01T00:00:00.000Z");
  const patch = { text: "nuevo" };
  const result = applyUpdate(item, patch, "2024-02-02T00:00:00.000Z");
  assert.ok(result);
  assert.notStrictEqual(result, item);
  assert.strictEqual(result.text, "nuevo");
  assert.notStrictEqual(result.updatedAt, item.updatedAt);
});

test("applyUpdate cambia done", () => {
  const item = makeItem("original");
  const patch = { done: true };
  const result = applyUpdate(item, patch);
  assert.ok(result);
  assert.strictEqual(result.done, true);
});

test("un patch que no cambia nada devuelve la misma ficha, sin tocar updatedAt", () => {
  const item = makeItem("original");
  const patch = { text: "original", done: false };
  const result = applyUpdate(item, patch);
  assert.strictEqual(result, item);
});

test("applyUpdate devuelve null si el texto del patch es vacío", () => {
  const item = makeItem("original");
  const patch = { text: "" };
  const result = applyUpdate(item, patch);
  assert.strictEqual(result, null);
});

test("pendingCount cuenta solo las que tienen done distinto de true", () => {
  const items = [
    { text: "uno", done: false },
    { text: "dos", done: true },
    { text: "tres", done: false },
  ];
  const result = pendingCount(items);
  assert.strictEqual(result, 2);
});

test("pendingCount devuelve 0 si todas las notas están completadas", () => {
  const items = [
    { text: "uno", done: true },
    { text: "dos", done: true },
  ];
  const result = pendingCount(items);
  assert.strictEqual(result, 0);
});

test("pendingCount devuelve 0 si no hay notas", () => {
  const result = pendingCount([]);
  assert.strictEqual(result, 0);
});

test("pruneProjects con menos claves que el tope devuelve [] y no borra nada", () => {
  const notes = { a: { text: "uno" }, b: { text: "dos" } };
  const result = pruneProjects(notes, 5);
  assert.deepEqual(result, []);
  assert.strictEqual(Object.keys(notes).length, 2);
});

test("pruneProjects borra las claves de updatedAt más antiguo cuando supera el tope", () => {
  const notes = {
    a: { updatedAt: "2023-01-01T00:00:00Z" },
    b: { updatedAt: "2023-01-02T00:00:00Z" },
    c: { updatedAt: "2023-01-03T00:00:00Z" },
    d: { updatedAt: "2023-01-04T00:00:00Z" },
  };
  const result = pruneProjects(notes, 2);
  assert.deepEqual(result.sort(), ["a", "b"]);
  assert.deepEqual(Object.keys(notes).sort(), ["c", "d"]);
});

test("una carpeta sin updatedAt es la primera en caer", () => {
  const notes = { vieja: {}, nueva: { updatedAt: "2024-05-05T00:00:00Z" } };
  assert.deepEqual(pruneProjects(notes, 1), ["vieja"]);
});
