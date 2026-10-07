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
  start     Launch in the background and wait for API and frontend readiness
  restart   Relaunch the local source development service
  stop      Stop the local Viron development service
  down      Alias for stop
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

url_host() {
  local host
  host="$(bind_host)"
  case "$host" in
    0.0.0.0) printf '127.0.0.1\n' ;;
    ::|\[::\]) printf '[::1]\n' ;;
    \[*\]) printf '%s\n' "$host" ;;
    *:*) printf '[%s]\n' "$host" ;;
    *) printf '%s\n' "$host" ;;
  esac
}

web_client_enabled() {
  [[ "$(env_value "WEB_CLIENT_ENABLED" "true" | tr '[:upper:]' '[:lower:]')" == "true" ]]
}

ensure_runtime_dirs() {
  mkdir -p "$TMP_DIR"
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

http_ready() {
  local url="$1"
  local port="$2"
  local pid
  local listener=0
  while IFS= read -r pid; do
    if is_project_pid "$pid"; then
      listener=1
      break
    fi
  done < <(port_pids "$port")
  [[ "$listener" -eq 1 ]] || return 1

  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --noproxy '*' --connect-timeout 1 --max-time 1 "$url" 2>/dev/null)" || return 1
  [[ "$status" == "200" ]]
}

startup_failure() {
  echo "$1"
  echo "Recent service log ($LOG_FILE):"
  tail -n 40 "$LOG_FILE" 2>/dev/null || true
  return 1
}

wait_for_service() {
  local pid="$1"
  local timeout="$2"
  local api
  local web
  api="$(api_port)"
  web="$(web_port)"
  local api_url="http://$(url_host):$api"
  local web_url="http://$(url_host):$web/"
  local web_enabled=0
  if web_client_enabled; then
    web_enabled=1
    echo "Frontend: $web_url"
  else
    echo "Frontend: disabled"
  fi
  echo "API: $api_url"
  echo "Log: $LOG_FILE"
  echo "Waiting for service readiness (timeout: ${timeout}s)..."

  local started="$SECONDS"
  local deadline=$((SECONDS + timeout))
  local next_progress="$SECONDS"
  local api_announced=0
  local web_announced=0
  local api_ready
  local web_ready
  local pending="API"
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    if ! pid_running "$pid"; then
      startup_failure "Viron dev service exited before becoming ready."
      return 1
    fi

    api_ready=0
    web_ready=$((1 - web_enabled))
    if http_ready "$api_url/readyz" "$api"; then
      api_ready=1
      if [[ "$api_announced" -eq 0 ]]; then
        echo "API ready: $api_url"
        api_announced=1
      fi
    fi
    if [[ "$web_enabled" -eq 1 ]] && http_ready "$web_url" "$web"; then
      web_ready=1
      if [[ "$web_announced" -eq 0 ]]; then
        echo "Frontend ready: $web_url"
        web_announced=1
      fi
    fi
    if [[ "$api_ready" -eq 1 && "$web_ready" -eq 1 ]] && pid_running "$pid"; then
      echo "Viron dev service is ready."
      return 0
    fi

    pending=""
    [[ "$api_ready" -eq 1 ]] || pending="API"
    if [[ "$web_ready" -eq 0 ]]; then
      pending="${pending:+$pending and }frontend"
    fi
    if [[ "$SECONDS" -ge "$next_progress" ]]; then
      echo "Waiting for $pending... ($((SECONDS - started))s elapsed)"
      next_progress=$((SECONDS + 5))
    fi
    [[ "$SECONDS" -lt "$deadline" ]] && sleep 1
  done
  startup_failure "Timed out after ${timeout}s waiting for $pending. The background service may still be initializing; use logs to inspect it or stop/down to stop it."
}

start_service() {
  ensure_runtime_dirs

  local timeout
  timeout="${DEV_SERVICE_HEALTH_TIMEOUT_SECONDS:-$(env_value "DEV_SERVICE_HEALTH_TIMEOUT_SECONDS" "120")}"
  if [[ ! "$timeout" =~ ^[1-9][0-9]*$ ]]; then
    echo "DEV_SERVICE_HEALTH_TIMEOUT_SECONDS must be a positive integer."
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to wait for service readiness."
    return 1
  fi

  local existing_pid
  existing_pid="$(service_pid)"
  if [[ -n "$existing_pid" ]] && pid_running "$existing_pid"; then
    echo "Viron dev service is already running with PID $existing_pid."
    status_service
    wait_for_service "$existing_pid" "$timeout"
    return
  fi

  if is_macos && launchd_job_exists; then
    launchctl bootout "$(launchd_target)" >/dev/null 2>&1 || true
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
    startup_failure "Viron dev service did not expose a process ID."
    return 1
  fi
  printf '%s\n' "$pid" > "$PID_FILE"

  echo "Viron dev service launched with PID $pid."
  wait_for_service "$pid" "$timeout"
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
  stop|down)
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
