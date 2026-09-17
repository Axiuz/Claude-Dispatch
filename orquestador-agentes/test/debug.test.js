const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { catalog, defaultStepIds, planSteps, summarize, repoRootFrom, STEPS } = require("../debug");

// ---------- catálogo ----------

test("catalog devuelve un objeto por paso con id, label y optional booleano", () => {
  const pasos = catalog();
  assert.equal(pasos.length, STEPS.length);
  pasos.forEach((paso) => {
    assert.equal(typeof paso.id, "string");
    assert.equal(typeof paso.label, "string");
    assert.equal(typeof paso.optional, "boolean");
  });
});

test("catalog no expone la función run", () => {
  assert.equal(catalog()[0].run, undefined);
});

test("defaultStepIds deja fuera los pasos opcionales", () => {
  const porDefecto = defaultStepIds();
  assert.ok(!porDefecto.includes("build"));
  assert.ok(!porDefecto.includes("reinicio"));
  assert.ok(porDefecto.includes("tests"));
});

test("el rebuild y el reinicio son los únicos opcionales", () => {
  assert.deepEqual(
    STEPS.filter((s) => s.optional).map((s) => s.id),
    ["build", "reinicio"]
  );
});

// ---------- selección de pasos ----------

test("planSteps sin ids corre los pasos por defecto", () => {
  assert.deepEqual(planSteps([]).map((s) => s.id), defaultStepIds());
});

test("planSteps respeta el orden del catálogo aunque los ids lleguen al revés", () => {
  assert.deepEqual(planSteps(["seguridad", "datos", "entorno"]).map((s) => s.id), ["entorno", "datos", "seguridad"]);
});

test("planSteps ignora un id inventado", () => {
  assert.deepEqual(planSteps(["datos", "no-existe"]).map((s) => s.id), ["datos"]);
});

test("planSteps deja el reinicio para el final", () => {
  const ids = planSteps(["reinicio", "build", "entorno"]).map((s) => s.id);
  assert.equal(ids[ids.length - 1], "reinicio");
});

// ---------- resumen ----------

const resultado = (id, status, ms = 10) => ({ id, status, ok: status !== "fail", skipped: status === "skip", ms });

test("summarize con todo en verde da ok true y ningún fallo", () => {
  const s = summarize([resultado("a", "ok"), resultado("b", "ok")]);
  assert.equal(s.ok, true);
  assert.equal(s.failed, 0);
  assert.equal(s.total, 2);
});

test("summarize con un fallo da ok false", () => {
  const s = summarize([resultado("a", "ok"), resultado("b", "fail")]);
  assert.equal(s.ok, false);
  assert.equal(s.failed, 1);
});

test("summarize cuenta los saltados y suma los tiempos", () => {
  const s = summarize([resultado("a", "ok", 100), resultado("b", "skip", 5)]);
  assert.equal(s.skipped, 1);
  assert.equal(s.ms, 105);
});

test("un paso saltado no cuenta como fallo", () => {
  assert.equal(summarize([resultado("a", "skip")]).ok, true);
});

// ---------- raíz del repositorio ----------

test("repoRootFrom devuelve null en una carpeta cualquiera", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-"));
  assert.equal(repoRootFrom(dir), null);
});

test("repoRootFrom reconoce el repositorio por Scripts y test", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "debug-"));
  const app = path.join(root, "orquestador-agentes");
  fs.mkdirSync(path.join(app, "test"), { recursive: true });
  fs.mkdirSync(path.join(root, "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "Scripts", "build-dmg.sh"), "#!/bin/bash\n");
  assert.equal(repoRootFrom(app), root);
});

test("sin la carpeta test no hay repositorio: es el bundle de la app", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "debug-"));
  const app = path.join(root, "app");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(root, "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "Scripts", "build-dmg.sh"), "#!/bin/bash\n");
  assert.equal(repoRootFrom(app), null);
});
