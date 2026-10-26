#!/bin/zsh

set -euo pipefail

readonly SESSION_NAME="codex-bridge-web-dev"
readonly SCRIPT_DIR="${0:A:h}"
readonly PROJECT_ROOT="${SCRIPT_DIR:h}"
readonly WEB_DEV_HOST="${WEB_DEV_HOST:-127.0.0.1}"
readonly WEB_DEV_PORT="${WEB_DEV_PORT:-51049}"
readonly WEB_DEV_TLS_CERT_FILE="${WEB_DEV_TLS_CERT_FILE:-}"
readonly WEB_DEV_TLS_KEY_FILE="${WEB_DEV_TLS_KEY_FILE:-}"

require_tmux() {
  if ! command -v tmux >/dev/null 2>&1; then
    print -u2 "tmux is required. Install it with: brew install tmux"
    exit 1
  fi
}

is_running() {
  tmux has-session -t "${SESSION_NAME}" 2>/dev/null
}

has_dead_panes() {
  tmux list-panes -s -t "${SESSION_NAME}" -F '#{pane_dead}' | grep -q '^1$'
}

session_option() {
  tmux show-option -t "${SESSION_NAME}" -qv "$1"
}

print_status() {
  if ! is_running; then
    print "Web dev is stopped."
    return
  fi

  if has_dead_panes; then
    print "Web dev tmux session exists, but one or more processes have exited."
  else
    local -r web_dev_host="$(session_option @bridge_web_dev_host)"
    local -r web_dev_port="$(session_option @bridge_web_dev_port)"
    if [[ -n "${web_dev_host}" && -n "${web_dev_port}" ]]; then
      local -r web_dev_protocol="$(session_option @bridge_web_dev_protocol)"
      print "Web dev is running at ${web_dev_protocol:-http}://${web_dev_host}:${web_dev_port}"
    else
      print "Web dev is running, but its address is unavailable."
    fi
  fi
  tmux list-windows -t "${SESSION_NAME}" \
    -F '#{window_index}:#{window_name} command=#{pane_current_command} dead=#{pane_dead} exit=#{pane_dead_status}'
}

start() {
  if [[ -n "${WEB_DEV_TLS_CERT_FILE}" || -n "${WEB_DEV_TLS_KEY_FILE}" ]]; then
    if [[ ! -r "${WEB_DEV_TLS_CERT_FILE}" || ! -r "${WEB_DEV_TLS_KEY_FILE}" ]]; then
      print -u2 "Set both WEB_DEV_TLS_CERT_FILE and WEB_DEV_TLS_KEY_FILE to readable certificate files."
      exit 1
    fi
  fi
  if is_running; then
    local -r existing_root="$(tmux show-option -t "${SESSION_NAME}" -qv @bridge_web_dev_root)"
    if [[ -n "${existing_root}" && "${existing_root}" != "${PROJECT_ROOT}" ]]; then
      print -u2 "tmux session ${SESSION_NAME} belongs to ${existing_root}; refusing to reuse it."
      exit 1
    fi
    print_status
    if has_dead_panes; then
      print -u2 "Stop the failed session before starting it again: corepack yarn web-dev:stop"
      exit 1
    fi
    return
  fi

  tmux new-session -d -s "${SESSION_NAME}" -n ui -c "${PROJECT_ROOT}" \
    "exec corepack yarn web:watch"
  tmux set-window-option -t "${SESSION_NAME}:ui" remain-on-exit on >/dev/null
  tmux set-option -t "${SESSION_NAME}" @bridge_web_dev_root "${PROJECT_ROOT}" >/dev/null
  tmux set-option -t "${SESSION_NAME}" @bridge_web_dev_host "${WEB_DEV_HOST}" >/dev/null
  tmux set-option -t "${SESSION_NAME}" @bridge_web_dev_port "${WEB_DEV_PORT}" >/dev/null
  tmux set-option -t "${SESSION_NAME}" @bridge_web_dev_protocol "$([[ -n "${WEB_DEV_TLS_CERT_FILE}" ]] && print https || print http)" >/dev/null

  tmux set-environment -t "${SESSION_NAME}" DOTENV_CONFIG_PATH ".env.bridge"
  tmux set-environment -t "${SESSION_NAME}" DOTENV_OVERRIDE "false"
  tmux set-environment -t "${SESSION_NAME}" TELEGRAM_BOT_TOKEN ""
  tmux set-environment -t "${SESSION_NAME}" SLACK_ENABLED "false"
  tmux set-environment -t "${SESSION_NAME}" WEB_ENABLED "true"
  tmux set-environment -t "${SESSION_NAME}" WEB_HOST "${WEB_DEV_HOST}"
  tmux set-environment -t "${SESSION_NAME}" WEB_PORT "${WEB_DEV_PORT}"
  tmux set-environment -t "${SESSION_NAME}" WEB_TLS_CERT_FILE "${WEB_DEV_TLS_CERT_FILE}"
  tmux set-environment -t "${SESSION_NAME}" WEB_TLS_KEY_FILE "${WEB_DEV_TLS_KEY_FILE}"
  tmux set-environment -t "${SESSION_NAME}" BRIDGE_DB_FILE "./workspaces/web-dev.sqlite"

  tmux new-window -d -t "${SESSION_NAME}:" -n bridge -c "${PROJECT_ROOT}" \
    "exec corepack yarn dev:watch"
  tmux set-window-option -t "${SESSION_NAME}:bridge" remain-on-exit on >/dev/null
  tmux select-window -t "${SESSION_NAME}:bridge"
  print_status
  print "Attach with: corepack yarn web-dev:attach"
}

attach() {
  if ! is_running; then
    print -u2 "Web dev is stopped. Start it with: corepack yarn web-dev:start"
    exit 1
  fi
  exec tmux attach-session -t "${SESSION_NAME}"
}

stop() {
  if ! is_running; then
    print "Web dev is already stopped."
    return
  fi
  tmux kill-session -t "${SESSION_NAME}"
  print "Web dev stopped."
}

require_tmux
case "${1:-}" in
  start) start ;;
  attach) attach ;;
  status) print_status ;;
  stop) stop ;;
  *)
    print -u2 "Usage: ${0:t} {start|attach|status|stop}"
    exit 2
    ;;
esac
