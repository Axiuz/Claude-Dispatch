#!/bin/bash
# Lanzador de Claude Dispatch.app. Lo invoca la app nativa (ClaudeDispatch.swift):
#   launcher.sh start   arranca LM Studio y el orquestador; imprime la URL del panel
#   launcher.sh stop    detiene el orquestador (LM Studio se queda corriendo)
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

  # Cargar el modelo en segundo plano: tarda y el panel ya sabe mostrar "no reachable"
  local model parallel
  model="$(config_value model)"
  parallel="$(config_value max_parallel)"
  if [ -n "$model" ] && ! "$lms" ps 2>/dev/null | grep -qw "$model"; then
    nohup "$lms" load "$model" -y --parallel "${parallel:-4}" >>"$LOG_DIR/lmstudio.log" 2>&1 &
  fi
}

start_orquestador() {
  is_up && return 0
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

stop_orquestador() {
  [ -f "$PID_FILE" ] || return 0
  kill "$(cat "$PID_FILE")" 2>/dev/null
  rm -f "$PID_FILE"
}

case "${1:-start}" in
  start)
    start_lmstudio
    start_orquestador
    panel_url
    ;;
  stop) stop_orquestador ;;
  *) fail "Uso: launcher.sh start|stop" ;;
esac
