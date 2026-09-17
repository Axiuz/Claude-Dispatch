// Tests del lector de transcripts de Claude Code. Se ejecutan con:
//   node --test test/claudeusage.test.js
// Sin dependencias: runner integrado de Node.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  addUsage,
  parseEntry,
  splitLines,
  emptyTotals,
  dayKey,
  createTracker,
} = require("../claudeusage");

// ---------- addUsage ----------

test("addUsage suma los cuatro conceptos y el total es su suma", () => {
  const totals = addUsage(emptyTotals(), {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 3,
  });
  assert.equal(totals.input, 10);
  assert.equal(totals.output, 20);
  assert.equal(totals.cacheCreate, 5);
  assert.equal(totals.cacheRead, 3);
  assert.equal(totals.total, 38);
  assert.equal(totals.messages, 1);
});

test("addUsage con usage nulo deja el acumulador como estaba", () => {
  const before = { input: 10, output: 20, cacheCreate: 5, cacheRead: 3, total: 38, messages: 2 };
  assert.deepEqual(addUsage(before, null), {
    input: 10,
    output: 20,
    cacheCreate: 5,
    cacheRead: 3,
    total: 38,
    messages: 2,
  });
});

test("addUsage trata como 0 los campos que no vienen", () => {
  const totals = addUsage(emptyTotals(), { input_tokens: 10, output_tokens: 20 });
  assert.equal(totals.cacheCreate, 0);
  assert.equal(totals.cacheRead, 0);
  assert.equal(totals.total, 30);
});

test("addUsage acumula varias respuestas", () => {
  const totals = emptyTotals();
  addUsage(totals, { input_tokens: 1, output_tokens: 2 });
  addUsage(totals, { input_tokens: 3, output_tokens: 4 });
  assert.equal(totals.total, 10);
  assert.equal(totals.messages, 2);
});

// ---------- parseEntry ----------

const assistantLine = (extra = {}, message = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2024-04-05T10:00:00Z",
    ...extra,
    message: {
      id: "msg_1",
      model: "claude-opus-5",
      usage: { input_tokens: 10, output_tokens: 20 },
      ...message,
    },
  });

test("parseEntry devuelve id, modelo y usage de una entrada del asistente", () => {
  const entry = parseEntry(assistantLine());
  assert.equal(entry.id, "msg_1");
  assert.equal(entry.model, "claude-opus-5");
  assert.equal(entry.usage.input_tokens, 10);
  assert.equal(entry.ts, "2024-04-05T10:00:00Z");
});

test("parseEntry ignora las entradas que no son del asistente", () => {
  const line = JSON.stringify({ type: "user", message: { usage: { input_tokens: 5 } } });
  assert.equal(parseEntry(line), null);
});

test("parseEntry ignora una línea sin usage, sin llegar a parsearla", () => {
  assert.equal(parseEntry('{"type":"assistant","message":{"content":"hola"}}'), null);
});

test("parseEntry aguanta una línea a medio escribir", () => {
  // claude sigue escribiendo el archivo mientras lo leemos: la última línea
  // puede estar cortada y eso no puede tumbar al servidor
  assert.equal(parseEntry('{"type":"assistant","message":{"usage":{"input_to'), null);
  assert.equal(parseEntry(""), null);
  assert.equal(parseEntry(null), null);
});

test("parseEntry descarta las respuestas sintéticas, que no son gasto real", () => {
  assert.equal(parseEntry(assistantLine({}, { model: "<synthetic>" })), null);
});

test("parseEntry cae en requestId cuando la respuesta no trae message.id", () => {
  const entry = parseEntry(assistantLine({ requestId: "req_abc" }, { id: undefined }));
  assert.equal(entry.id, "req_abc");
});

test("parseEntry saca el día del timestamp", () => {
  const entry = parseEntry(assistantLine({ timestamp: "2024-04-05T10:00:00Z" }));
  assert.equal(entry.day, dayKey(new Date("2024-04-05T10:00:00Z")));
});

// ---------- splitLines ----------

test("splitLines separa las líneas completas y guarda el resto", () => {
  const { lines, rest } = splitLines(Buffer.from("uno\ndos\ntres a med"));
  assert.deepEqual(lines, ["uno", "dos"]);
  assert.equal(rest.toString("utf8"), "tres a med");
});

test("splitLines no parte un carácter multibyte entre dos lecturas", () => {
  // "café" ocupa 5 bytes: si el corte cae en medio de la é, decodificar cada
  // trozo por separado daría basura. Por eso el resto se guarda como Buffer.
  const entero = Buffer.from("café\n");
  const primero = splitLines(entero.slice(0, 4)); // corta la é por la mitad
  assert.deepEqual(primero.lines, []);
  const segundo = splitLines(Buffer.concat([primero.rest, entero.slice(4)]));
  assert.deepEqual(segundo.lines, ["café"]);
  assert.equal(segundo.rest.length, 0);
});

test("splitLines sin salto de línea no devuelve nada y lo guarda todo", () => {
  const { lines, rest } = splitLines(Buffer.from("sin salto"));
  assert.deepEqual(lines, []);
  assert.equal(rest.toString("utf8"), "sin salto");
});

// ---------- dayKey ----------

test("dayKey devuelve YYYY-MM-DD en hora local", () => {
  assert.equal(dayKey(new Date(2024, 3, 5, 13, 30)), "2024-04-05");
  assert.equal(dayKey(new Date(2024, 0, 9, 0, 1)), "2024-01-09");
});

test("dayKey devuelve null si la fecha no es una fecha", () => {
  assert.equal(dayKey(new Date("no soy una fecha")), null);
  assert.equal(dayKey("tampoco"), null);
});

// ---------- tracker sobre una carpeta de mentira ----------

function fakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudeusage-"));
  fs.mkdirSync(path.join(root, "-un-proyecto"));
  return root;
}

const line = (id, usage, ts = new Date().toISOString()) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { id, model: "claude-opus-5", usage },
  }) + "\n";

test("el tracker suma lo que hay y lo cuenta como de hoy", () => {
  const root = fakeRoot();
  const file = path.join(root, "-un-proyecto", "sesion.jsonl");
  fs.writeFileSync(file, line("a", { input_tokens: 1, output_tokens: 2 }));

  const tracker = createTracker({ root, pollMs: 0 });
  const snap = tracker.start();
  tracker.stop();

  assert.equal(snap.available, true);
  assert.equal(snap.window.total, 3);
  assert.equal(snap.today.total, 3);
  assert.equal(snap.sessions.today, 1);
  assert.equal(snap.models[0].model, "claude-opus-5");
});

test("una respuesta repetida en varias líneas se cuenta una sola vez", () => {
  const root = fakeRoot();
  const file = path.join(root, "-un-proyecto", "sesion.jsonl");
  const usage = { input_tokens: 10, output_tokens: 5 };
  // razonamiento, texto y tool_use salen como tres entradas con el mismo id
  fs.writeFileSync(file, line("msg_1", usage) + line("msg_1", usage) + line("msg_1", usage));

  const tracker = createTracker({ root, pollMs: 0 });
  const snap = tracker.start();
  tracker.stop();

  assert.equal(snap.window.messages, 1);
  assert.equal(snap.window.total, 15);
});

test("el tracker solo lee lo que se añadió, y avisa por onChange", () => {
  const root = fakeRoot();
  const file = path.join(root, "-un-proyecto", "sesion.jsonl");
  fs.writeFileSync(file, line("a", { input_tokens: 1, output_tokens: 1 }));

  const avisos = [];
  const tracker = createTracker({ root, pollMs: 0, onChange: (s) => avisos.push(s) });
  tracker.start();

  tracker.tick(); // nada nuevo: no debe volver a avisar ni a contar
  assert.equal(avisos.length, 1);

  fs.appendFileSync(file, line("b", { input_tokens: 2, output_tokens: 2 }));
  tracker.tick();
  tracker.stop();

  assert.equal(avisos.length, 2);
  assert.equal(avisos[1].window.total, 6);
  assert.equal(avisos[1].window.messages, 2);
});

test("una línea a medias se completa en la siguiente lectura", () => {
  const root = fakeRoot();
  const file = path.join(root, "-un-proyecto", "sesion.jsonl");
  const entera = line("a", { input_tokens: 4, output_tokens: 4 });
  fs.writeFileSync(file, entera.slice(0, 30));

  const tracker = createTracker({ root, pollMs: 0 });
  let snap = tracker.start();
  assert.equal(snap.window.messages, 0);

  fs.appendFileSync(file, entera.slice(30));
  tracker.tick();
  snap = tracker.snapshot();
  tracker.stop();

  assert.equal(snap.window.messages, 1);
  assert.equal(snap.window.total, 8);
});

test("sin carpeta de transcripts el tracker lo dice en vez de reventar", () => {
  const tracker = createTracker({ root: path.join(os.tmpdir(), "no-existe-" + Date.now()), pollMs: 0 });
  const snap = tracker.start();
  tracker.stop();
  assert.equal(snap.available, false);
  assert.equal(snap.window.total, 0);
});
