#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$ROOT_DIR/.tmp"
PID_FILE="$TMP_DIR/envman-dev.pid"
LOG_FILE="$TMP_DIR/envman-dev.log"
ENV_FILE="$ROOT_DIR/.env"
DEFAULT_API_PORT="8080"
DEFAULT_WEB_PORT="5173"
LAUNCHD_LABEL="com.viron.dev"

usage() {
  cat <<'USAGE'
Usage: scripts/dev-service.sh <command>

Commands:
  start     Start the local Viron development service
  restart   Restart the local Viron development service
  stop      Stop the local Viron development service
  status    Show service status and listening ports
  logs      Tail the local service log

Examples:
  ./scripts/dev-service.sh start
  ./scripts/dev-service.sh restart
  npm run service -- status
USAGE
}

env_value() {
  local key="$1"
  local fallback="$2"

  if [[ ! -f "$ENV_FILE" ]]; then
    printf '%s\n' "$fallback"
    return
  fi

  local value
  value="$(
    awk -F= -v key="$key" '
      $1 == key {
        value = substr($0, length(key) + 2)
        gsub(/^[ \t]+|[ \t]+$/, "", value)
        gsub(/^"|"$/, "", value)
        gsub(/^'\''|'\''$/, "", value)
        print value
        exit
      }
    ' "$ENV_FILE"
  )"

  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$fallback"
  fi
}

api_port() {
  env_value "PORT" "$DEFAULT_API_PORT"
}

web_port() {
  printf '%s\n' "$DEFAULT_WEB_PORT"
}

bind_host() {
  env_value "HOST" "127.0.0.1"
}

web_client_enabled() {
  [[ "$(env_value "WEB_CLIENT_ENABLED" "true" | tr '[:upper:]' '[:lower:]')" == "true" ]]
}

health_timeout_seconds() {
  local value
  value="${DEV_SERVICE_HEALTH_TIMEOUT_SECONDS:-$(env_value "DEV_SERVICE_HEALTH_TIMEOUT_SECONDS" "60")}"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "DEV_SERVICE_HEALTH_TIMEOUT_SECONDS must be a positive integer." >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

script_runner_image() {
  local product_version
  product_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT_DIR/package.json")"
  env_value "SCRIPT_RUNNER_IMAGE" "viron-script-runner:$product_version"
}

ensure_script_runner() {
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "Script runner unavailable: Docker is not running; script synchronization will remain disabled."
    return
  fi
  if docker image inspect "$(script_runner_image)" >/dev/null 2>&1; then
    return
  fi
  echo "Building isolated Viron script runner image..."
  docker compose -f "$ROOT_DIR/docker-compose.full.yml" build script-runner
}

ensure_runtime_dirs() {
  mkdir -p "$TMP_DIR"
}

ensure_dependencies() {
  if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
    echo "node_modules is missing. Run npm ci first."
    exit 1
  fi
}

is_macos() {
  [[ "$(uname -s)" == "Darwin" ]]
}

launchd_target() {
  printf 'gui/%s/%s\n' "$(id -u)" "$LAUNCHD_LABEL"
}

launchd_job_exists() {
  is_macos && launchctl print "$(launchd_target)" >/dev/null 2>&1
}

launchd_pid() {
  launchctl print "$(launchd_target)" 2>/dev/null |
    awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }'
}

service_pid() {
  if is_macos && launchd_job_exists; then
    launchd_pid
  elif [[ -f "$PID_FILE" ]]; then
    cat "$PID_FILE"
  fi
  return 0
}

pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || lsof -p "$pid" -Fn >/dev/null 2>&1
}

process_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }'
}

is_project_pid() {
  local pid="$1"
  local cwd
  cwd="$(process_cwd "$pid")"
  [[ "$cwd" == "$ROOT_DIR" ]]
}

port_pids() {
  local port="$1"
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

known_pids() {
  {
    if is_macos && launchd_job_exists; then
      launchd_pid
    fi
    if [[ -f "$PID_FILE" ]]; then
      cat "$PID_FILE"
    fi
    port_pids "$(api_port)"
    if web_client_enabled; then
      port_pids "$(web_port)"
    fi
  } | awk 'NF && !seen[$0]++'
}

stop_pid() {
  local pid="$1"
  local label="$2"

  if ! pid_running "$pid"; then
    return 1
  fi

  if ! is_project_pid "$pid"; then
    echo "Skip $label PID $pid because it is not running from $ROOT_DIR"
    return 1
  fi

  echo "Stopping $label PID $pid"
  kill "$pid" 2>/dev/null || true

  for _ in {1..30}; do
    if ! pid_running "$pid"; then
      return 0
    fi
    sleep 0.2
  done

  echo "Force stopping $label PID $pid"
  kill -9 "$pid" 2>/dev/null || true
}

stop_service() {
  ensure_runtime_dirs
  local stopped=0
  local pid

  if is_macos && launchd_job_exists; then
    echo "Stopping launchd service $LAUNCHD_LABEL"
    if launchctl bootout "$(launchd_target)"; then
      stopped=1
    else
      echo "Could not unload launchd service $LAUNCHD_LABEL."
    fi
  fi

  while IFS= read -r pid; do
    if stop_pid "$pid" "Viron dev service"; then
      stopped=1
    fi
  done < <(known_pids)

  rm -f "$PID_FILE"

  if [[ "$stopped" -eq 0 ]]; then
    echo "Viron dev service is not running."
  else
    echo "Viron dev service stopped."
  fi
}

wait_for_health() {
  local port
  port="$(api_port)"
  local attempts
  attempts="$(( $(health_timeout_seconds) * 5 ))"

  for (( attempt = 0; attempt < attempts; attempt += 1 )); do
    if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
      return 0
    fi

    local pid
    pid="$(service_pid)"
    if [[ -n "$pid" ]] && ! pid_running "$pid"; then
      return 1
    fi
    if is_macos && ! launchd_job_exists; then
      return 1
    fi

    sleep 0.2
  done

  return 1
}

start_service() {
  ensure_runtime_dirs
  ensure_dependencies
  ensure_script_runner

  local existing_pid
  existing_pid="$(service_pid)"
  if [[ -n "$existing_pid" ]] && pid_running "$existing_pid"; then
    echo "Viron dev service is already running with PID $existing_pid."
    status_service
    return 0
  fi

  if is_macos && launchd_job_exists; then
    launchctl bootout "$(launchd_target)" >/dev/null 2>&1 || true
  fi

  if [[ -n "$(port_pids "$(api_port)")" ]] || { web_client_enabled && [[ -n "$(port_pids "$(web_port)")" ]]; }; then
    echo "A required Viron port is already in use. Run restart or stop first."
    status_service
    exit 1
  fi

  : > "$LOG_FILE"
  rm -f "$PID_FILE"
  echo "Starting Viron dev service..."
  if is_macos; then
    local launch_command
    printf -v launch_command 'cd %q && exec env TMPDIR=%q node scripts/dev.mjs' "$ROOT_DIR" "$TMP_DIR"
    launchctl submit -l "$LAUNCHD_LABEL" -o "$LOG_FILE" -e "$LOG_FILE" -- \
      /bin/zsh -lc "$launch_command"
  else
    (
      cd "$ROOT_DIR"
      nohup /bin/bash -c 'printf "%s\n" "$$" > "$1"; exec env TMPDIR="$2" node scripts/dev.mjs' _ "$PID_FILE" "$TMP_DIR" >"$LOG_FILE" 2>&1 </dev/null &
    )
  fi

  local pid
  for _ in {1..40}; do
    pid="$(service_pid)"
    [[ -n "$pid" ]] && break
    sleep 0.05
  done
  if [[ -z "$pid" ]]; then
    echo "Viron dev service did not expose a process ID."
    tail -n 40 "$LOG_FILE" || true
    exit 1
  fi
  printf '%s\n' "$pid" > "$PID_FILE"

  if wait_for_health; then
    sleep 0.5
    if ! pid_running "$pid"; then
      echo "Viron dev service exited after becoming healthy."
      echo "Last log lines:"
      tail -n 40 "$LOG_FILE" || true
      exit 1
    fi
    echo "Viron dev service started with PID $pid."
    if web_client_enabled; then
      echo "Frontend: http://$(bind_host):$(web_port)/"
    else
      echo "Frontend: disabled"
    fi
    echo "API: http://$(bind_host):$(api_port)"
    echo "Log: $LOG_FILE"
  else
    echo "Viron dev service did not become healthy."
    echo "Last log lines:"
    tail -n 40 "$LOG_FILE" || true
    exit 1
  fi
}

restart_service() {
  stop_service
  start_service
}

status_service() {
  ensure_runtime_dirs
  local api
  local web
  api="$(api_port)"
  web="$(web_port)"

  echo "Project: $ROOT_DIR"
  echo "PID file: $PID_FILE"
  echo "Log file: $LOG_FILE"
  if command -v docker >/dev/null 2>&1 && docker image inspect "$(script_runner_image)" >/dev/null 2>&1; then
    echo "Script runner image: $(script_runner_image) (ready)"
  else
    echo "Script runner image: $(script_runner_image) (not ready)"
  fi

  if is_macos; then
    if launchd_job_exists; then
      echo "Launchd service: $LAUNCHD_LABEL (loaded)"
    else
      echo "Launchd service: $LAUNCHD_LABEL (not loaded)"
    fi
  fi

  local pid
  pid="$(service_pid)"
  if [[ -n "$pid" ]]; then
    if pid_running "$pid"; then
      echo "Service PID: $pid (running)"
      printf '%s\n' "$pid" > "$PID_FILE"
    else
      echo "Service PID: $pid (stale)"
    fi
  else
    echo "Service PID: none"
  fi

  echo "Port $api:"
  lsof -nP -iTCP:"$api" -sTCP:LISTEN 2>/dev/null || echo "  not listening"

  if web_client_enabled; then
    echo "Port $web:"
    lsof -nP -iTCP:"$web" -sTCP:LISTEN 2>/dev/null || echo "  not listening"
  else
    echo "Frontend: disabled"
  fi
}

tail_logs() {
  ensure_runtime_dirs
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "Log file does not exist yet: $LOG_FILE"
    exit 1
  fi
  tail -f "$LOG_FILE"
}

command="${1:-}"
case "$command" in
  start)
    start_service
    ;;
  restart)
    restart_service
    ;;
  stop)
    stop_service
    ;;
  status)
    status_service
    ;;
  logs)
    tail_logs
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    echo "Unknown command: $command"
    usage
    exit 1
    ;;
esac
