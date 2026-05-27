#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${HAVYN_REPO_URL:-https://github.com/Treasure299/Havyn.git}"
APP_DIR="/opt/havyn"
SERVICE_FILE="/etc/systemd/system/havyn-socket.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git ufw

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! id havyn >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin havyn
fi

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

chown -R havyn:havyn "$APP_DIR"

sudo -u havyn npm --prefix "$APP_DIR" ci --workspaces --include-workspace-root

if [[ ! -f "$APP_DIR/apps/server/.env" ]]; then
  cp "$APP_DIR/deploy/oracle/.env.example" "$APP_DIR/apps/server/.env"
  chown havyn:havyn "$APP_DIR/apps/server/.env"
fi

cp "$APP_DIR/deploy/oracle/havyn-socket.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable havyn-socket
systemctl restart havyn-socket

ufw allow OpenSSH >/dev/null || true
ufw allow 4000/tcp >/dev/null || true
ufw --force enable >/dev/null || true

PUBLIC_IP="$(curl -fsS --max-time 3 https://api.ipify.org || true)"
echo
echo "Havyn Socket.IO server is installed."
echo "Health check: http://${PUBLIC_IP:-YOUR_ORACLE_PUBLIC_IP}:4000/health"
echo
echo "If Oracle network security list/VCN ingress is not open yet, allow TCP 4000 there too."
