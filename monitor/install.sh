#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_USER=""
INSTALL_DIR="/opt/viron/monitor"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --ssh-user)
      SSH_USER="${2:-}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "未知参数：$1" >&2
      echo "用法：sudo ./install.sh --ssh-user <Viron SSH 连接使用的 Linux 用户> [--install-dir /opt/viron/monitor]" >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 root 或 sudo 执行安装。" >&2
  exit 1
fi
if [[ -z "$SSH_USER" ]] || ! id "$SSH_USER" >/dev/null 2>&1; then
  echo "必须通过 --ssh-user 指定 Viron SSH 连接实际使用的 Linux 用户。" >&2
  exit 1
fi
if [[ ! "$INSTALL_DIR" =~ ^/opt/[A-Za-z0-9._/-]+$ ]] || [[ "$INSTALL_DIR" == *"/../"* ]] || [[ "$INSTALL_DIR" == */.. ]]; then
  echo "安装目录必须是 /opt 下不含空格或路径回退的绝对路径。" >&2
  exit 1
fi
if ! command -v realpath >/dev/null 2>&1 || [[ "$(realpath -m -- "$INSTALL_DIR")" != "$INSTALL_DIR" ]]; then
  echo "安装目录不能经过符号链接或非规范路径：$INSTALL_DIR" >&2
  exit 1
fi
for file in viron-monitor viron-monitor-collector viron-monitor.service viron-monitor.service.legacy THIRD_PARTY_NOTICES.md manifest.json SHA256SUMS; do
  if [[ ! -f "$SCRIPT_DIR/$file" ]]; then
    echo "安装目录缺少 $file。" >&2
    exit 1
  fi
done

(cd "$SCRIPT_DIR" && sha256sum -c SHA256SUMS)

INSTALL_MARKER="$INSTALL_DIR/.viron-monitor-install.json"
if [[ -L "$INSTALL_DIR" ]] || [[ -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR" ]]; then
  echo "安装路径已存在且不是目录：$INSTALL_DIR" >&2
  exit 1
fi
if [[ -d "$INSTALL_DIR" ]] && find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  if [[ ! -f "$INSTALL_MARKER" ]] || ! grep -Eq '"product"[[:space:]]*:[[:space:]]*"viron-monitor"' "$INSTALL_MARKER"; then
    echo "安装目录已被非 Viron 内容占用：$INSTALL_DIR" >&2
    exit 1
  fi
fi

for entry in viron-monitor viron-monitor-collector; do
  stable_path="/usr/local/bin/$entry"
  expected_path="$INSTALL_DIR/$entry"
  if [[ -e "$stable_path" || -L "$stable_path" ]]; then
    resolved_path="$(readlink -f "$stable_path" 2>/dev/null || printf '%s' "$stable_path")"
    if [[ "$resolved_path" != "$expected_path" ]]; then
      echo "命令入口已被其他内容占用：$stable_path" >&2
      exit 1
    fi
  fi
done

EXISTING_MONITOR="$(command -v viron-monitor 2>/dev/null || true)"
if [[ -n "$EXISTING_MONITOR" ]]; then
  EXISTING_MONITOR="$(readlink -f "$EXISTING_MONITOR" 2>/dev/null || printf '%s' "$EXISTING_MONITOR")"
  case "$EXISTING_MONITOR" in
    "$INSTALL_DIR"/*) ;;
    *)
      echo "检测到其他位置的 viron-monitor：$EXISTING_MONITOR。请先人工确认或迁移旧版安装。" >&2
      exit 1
      ;;
  esac
fi

if ! getent group viron-monitor >/dev/null 2>&1; then
  groupadd --system viron-monitor
fi
if ! id viron-monitor >/dev/null 2>&1; then
  useradd --system --gid viron-monitor --home-dir /var/lib/viron-monitor --shell /usr/sbin/nologin viron-monitor
fi
install -d -m 0755 -o root -g root "$INSTALL_DIR"
install -d -m 0755 -o root -g root /etc/viron-monitor
install -d -m 2770 -o root -g viron-monitor /var/lib/viron-monitor
if [[ ! -e /etc/viron-monitor/viron-monitor.env ]]; then
  printf '%s\n' \
    'VIRON_MONITOR_DATA_DIR=/var/lib/viron-monitor' \
    'VIRON_MONITOR_CONTROL_SOCKET=/run/viron-monitor/control.sock' \
    'VIRON_MONITOR_INTERVAL=30s' \
    'VIRON_MONITOR_MAX_BUFFER=256MiB' > /etc/viron-monitor/viron-monitor.env
fi
chown root:viron-monitor /etc/viron-monitor/viron-monitor.env
chmod 0640 /etc/viron-monitor/viron-monitor.env
install -m 0755 -o root -g root "$SCRIPT_DIR/viron-monitor" "$INSTALL_DIR/viron-monitor"
install -m 0755 -o root -g root "$SCRIPT_DIR/viron-monitor-collector" "$INSTALL_DIR/viron-monitor-collector"
install -m 0755 -o root -g root "$SCRIPT_DIR/install.sh" "$INSTALL_DIR/install.sh"
install -m 0644 -o root -g root "$SCRIPT_DIR/THIRD_PARTY_NOTICES.md" "$INSTALL_DIR/THIRD_PARTY_NOTICES.md"
install -m 0644 -o root -g root "$SCRIPT_DIR/manifest.json" "$INSTALL_DIR/manifest.json"
install -m 0644 -o root -g root "$SCRIPT_DIR/SHA256SUMS" "$INSTALL_DIR/SHA256SUMS"

ln -sfn "$INSTALL_DIR/viron-monitor" /usr/local/bin/viron-monitor
ln -sfn "$INSTALL_DIR/viron-monitor-collector" /usr/local/bin/viron-monitor-collector

SYSTEMD_VERSION="$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
if [[ "$SYSTEMD_VERSION" =~ ^[0-9]+$ ]] && (( SYSTEMD_VERSION >= 232 )); then
  install -m 0644 -o root -g root "$SCRIPT_DIR/viron-monitor.service" /etc/systemd/system/viron-monitor.service
else
  install -m 0644 -o root -g root "$SCRIPT_DIR/viron-monitor.service.legacy" /etc/systemd/system/viron-monitor.service
fi

VERSION="$($INSTALL_DIR/viron-monitor version | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
ARCHITECTURE="$(sed -n 's/.*"architecture":"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/manifest.json")"
INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"product":"viron-monitor","version":"%s","architecture":"%s","installPath":"%s","installedAt":"%s"}\n' \
  "$VERSION" "$ARCHITECTURE" "$INSTALL_DIR" "$INSTALLED_AT" > "$INSTALL_MARKER"
chmod 0644 "$INSTALL_MARKER"

usermod -a -G viron-monitor "$SSH_USER"
systemctl daemon-reload
systemctl enable viron-monitor
systemctl restart viron-monitor
systemctl --no-pager --full status viron-monitor
echo "安装完成：$INSTALL_DIR。请重新登录 SSH 用户 $SSH_USER，使 viron-monitor 组权限生效。"
