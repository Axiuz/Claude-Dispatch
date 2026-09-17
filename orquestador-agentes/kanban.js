// Reglas del tablero kanban. Están aquí y no en server.js para poder probarlas
// sin arrancar el servidor (ver test/kanban.test.js).

// Las cinco columnas, en el orden en que se ven en el panel.
const COLUMNS = ["todo", "progress", "review", "done", "errors"];

// Mapea estados antiguos (pending/running/error/approved) a columnas modernas.
// Existe porque el vocabulario de Claude Code usa estados, no columnas.
// La entrada approved -> done es para mantener compatibilidad con tableros
// antiguos donde la quinta columna se llamaba "approved": sin ella, esas tarjetas
// caerían en "todo".
const LEGACY_COLUMN = {
  pending: "todo",
  queued: "todo",
  running: "progress",
  error: "errors",
  approved: "done",
};

function columnFor(value, fallback = "todo") {
  if (COLUMNS.includes(value)) return value;
  return LEGACY_COLUMN[value] || fallback;
}

const bySort = (a, b) => (a.sort ?? a.order ?? 0) - (b.sort ?? b.order ?? 0);

// Mete el paso en una columna, en la posición pedida, y renumera esa columna
// para que el orden sea siempre 1..n sin huecos.
function placeStep(steps, step, column, index) {
  step.column = column;
  step.status = column; // el campo viejo se mantiene al día por compatibilidad
  const peers = steps.filter((s) => s.column === column && s !== step).sort(bySort);
  const at = Math.max(0, Math.min(Number.isInteger(index) ? index : peers.length, peers.length));
  peers.splice(at, 0, step);
  peers.forEach((s, i) => (s.sort = i + 1));
  return step;
}

// Define el destino de un paso tras un run local.
// Un paso que termina en "done" va a "review" (revisión) para que el usuario lo verifique.
// Un error va a "errors" y un cancelado vuelve a "todo".
const COLUMN_AFTER_RUN = { done: "review", error: "errors", cancelled: "todo" };

module.exports = { COLUMNS, LEGACY_COLUMN, COLUMN_AFTER_RUN, columnFor, bySort, placeStep };
