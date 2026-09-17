#!/bin/bash
# Lanzador de Claude Dispatch.app. Lo invoca la app nativa (ClaudeDispatch.swift):
#   launcher.sh start   arranca LM Studio y el orquestador; imprime la URL del panel
#   launcher.sh stop    detiene el orquestador y el servidor de LM Studio
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HERE/app"
DATA_DIR="$HOME/Library/Application Support/Claude Dispatch"
LOG_DIR="$HOME/Library/Logs/Claude Dispatch"
PID_FILE="$DATA_DIR/orquestador.pid"

# Las apps abiertas desde Finder no heredan el PATH de la terminal
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.lmstudio/bin:$PATH"
NVM_NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
[ -n "$NVM_NODE" ] && export PATH="$PATH:$NVM_NODE"

mkdir -p "$DATA_DIR" "$LOG_DIR"

fail() {
  echo "$1" >&2
  exit 1
}

config_value() {
  local file="$DATA_DIR/config.json"
  [ -f "$file" ] || file="$APP_DIR/data/config.json"
  node -p "require(process.argv[1])['$1'] ?? ''" "$file"
}

# Los modelos de config.json y de cada agente habilitado, sin repetir: el panel
# reparte los agentes entre varios modelos y todos tienen que estar cargados.
models_to_load() {
  local cfg="$DATA_DIR/config.json"
  [ -f "$cfg" ] || cfg="$APP_DIR/data/config.json"
  local agents="$DATA_DIR/agents.json"
  [ -f "$agents" ] || agents="$APP_DIR/data/agents.json"
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const list = Array.isArray(raw) ? raw : (raw.agents || []);
    const models = list.filter((a) => a.enabled !== false).map((a) => a.model);
    console.log([...new Set([cfg.model, ...models].filter(Boolean))].join("\n"));
  ' "$cfg" "$agents" 2>/dev/null || config_value model
}

panel_url() {
  echo "http://127.0.0.1:$(config_value app_port)"
}

is_up() {
  curl -s -m 1 -o /dev/null "$(panel_url)/api/manifest"
}

start_lmstudio() {
  local lms
  lms="$(command -v lms)" || fail "No encuentro 'lms', la CLI de LM Studio. Ábrelo una vez y actívala en Settings > Developer."

  if ! "$lms" server status --json 2>/dev/null | grep -q '"running":true'; then
    # --bind explícito: LM Studio recuerda la última configuración y podría abrirse a la red
    "$lms" server start --bind 127.0.0.1 >>"$LOG_DIR/lmstudio.log" 2>&1 ||
      fail "LM Studio no pudo arrancar su servidor. Revisa $LOG_DIR/lmstudio.log"
  fi

  # Cargar los modelos en segundo plano: tardan y el panel ya sabe mostrar
  # "no reachable". Son todos los que piden los agentes, no solo config.model:
  # hoy todos usan el mismo, pero un agente puede fijar el suyo y entonces
  # también tiene que estar cargado.
  local parallel model
  parallel="$(config_value max_parallel)"
  for model in $(models_to_load); do
    "$lms" ps 2>/dev/null | grep -qw "$model" && continue
    nohup "$lms" load "$model" -y --parallel "${parallel:-1}" >>"$LOG_DIR/lmstudio.log" 2>&1 &
  done
}

# El PID del proceso que tiene tomado el puerto del panel, si hay alguno.
# Sin puerto no se pregunta: un lsof -iTCP: vacío lista media máquina y lo que
# saliera de ahí acabaría en un kill.
listener_pid() {
  local port
  port="$(config_value app_port)"
  case "$port" in
    "" | *[!0-9]*) return 0 ;;
  esac
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1
}

start_orquestador() {
  # Un orquestador de un arranque anterior puede seguir con el puerto tomado: sin
  # esta comprobación is_up daría por bueno el servidor viejo y la app se quedaría
  # con el código de la versión anterior, sin sus rutas nuevas.
  if is_up; then
    local live
    live="$(listener_pid)"
    [ -n "$live" ] && [ "$live" = "$(cat "$PID_FILE" 2>/dev/null)" ] && return 0
    kill_pid "${live:-}"
  fi
  command -v node >/dev/null || fail "No encuentro Node.js. Instálalo desde nodejs.org o con Homebrew."

  cd "$APP_DIR" || fail "Falta la carpeta app dentro del bundle."
  ORQ_DATA_DIR="$DATA_DIR" ORQ_APP_ONLY=1 nohup node server.js >>"$LOG_DIR/orquestador.log" 2>&1 &
  echo $! >"$PID_FILE"

  for _ in $(seq 1 50); do
    is_up && return 0
    sleep 0.2
  done
  fail "El orquestador no respondió en 10 s. Revisa $LOG_DIR/orquestador.log"
}

# Termina un proceso y espera a que muera de verdad. Un SIGTERM sin esperar deja
# el puerto tomado el tiempo suficiente para que el siguiente arranque se enganche
# al servidor que acabamos de mandar cerrar.
kill_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
}

stop_orquestador() {
  local pid=""
  [ -f "$PID_FILE" ] && pid="$(cat "$PID_FILE")"
  rm -f "$PID_FILE"
  kill_pid "$pid"
  # Por si el PID file se perdió: lo que siga escuchando en el puerto es nuestro
  kill_pid "$(listener_pid)"
}

# Cerrar la app debe dejar la RAM libre: sin esto el modelo se queda cargado y
# el servidor escuchando aunque ya no haya nadie que le hable.
stop_lmstudio() {
  local lms
  lms="$(command -v lms)" || return 0
  "$lms" unload --all >>"$LOG_DIR/lmstudio.log" 2>&1 || true
  "$lms" server stop >>"$LOG_DIR/lmstudio.log" 2>&1 || true
}

case "${1:-start}" in
  start)
    start_lmstudio
    start_orquestador
    panel_url
    ;;
  stop)
    stop_orquestador
    stop_lmstudio
    ;;
  *) fail "Uso: launcher.sh start|stop" ;;
esac
