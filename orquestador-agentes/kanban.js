// Reglas del tablero kanban. Están aquí y no en server.js para poder probarlas
// sin arrancar el servidor (ver test/kanban.test.js).

// Las cinco columnas, en el orden en que se ven en el panel.
const COLUMNS = ["todo", "progress", "review", "done", "approved"];

// Claude Code —y el CLAUDE.md que ya está copiado en otros proyectos— habla de
// estados, no de columnas. Se traducen aquí para no romper lo que ya funciona.
// 'error' cae en revisión: un paso fallido es justo lo que hay que mirar.
const LEGACY_COLUMN = {
  pending: "todo",
  queued: "todo",
  running: "progress",
  error: "review",
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

// A dónde va un paso cuando su run termina. Lo que escribe un agente local no
// pasa a HECHO solo: va a REVISIÓN, que es donde el usuario lo comprueba.
const COLUMN_AFTER_RUN = { done: "review", error: "review", cancelled: "todo" };

module.exports = { COLUMNS, LEGACY_COLUMN, COLUMN_AFTER_RUN, columnFor, bySort, placeStep };
