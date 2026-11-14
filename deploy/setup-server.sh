#!/usr/bin/env bash
# One-time setup of the Curious Files app on a fresh Ubuntu server (tested target: Oracle Cloud
# "Always Free" Ampere A1, Ubuntu 24.04). Run as the default user (ubuntu) from the repo root:
#   bash deploy/setup-server.sh
# It installs Node.js, fonts, the app's packages and a systemd service that restarts on boot
# and on crashes. The dashboard stays bound to 127.0.0.1; reach it privately with Tailscale.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"

echo "==> System packages (Node.js 22, fonts, build tools)"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates git build-essential python3 fontconfig fonts-liberation fonts-dejavu-core sqlite3
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Font aliases (the video cards ask for Helvetica/Arial/Georgia)"
mkdir -p "$HOME/.config/fontconfig"
cat > "$HOME/.config/fontconfig/fonts.conf" <<'XML'
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias><family>Helvetica Neue</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>Helvetica</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>Arial</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>Georgia</family><prefer><family>Liberation Serif</family></prefer></alias>
</fontconfig>
XML
fc-cache -f >/dev/null

echo "==> App packages"
cd "$APP_DIR"
npm ci --omit=dev --foreground-scripts || npm install --omit=dev --foreground-scripts
mkdir -p data logs
chmod 600 .env config/*.json 2>/dev/null || true

echo "==> Swap (video rendering on a small server)"
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Service (starts on boot, restarts on failure)"
sudo tee /etc/systemd/system/curious-files.service >/dev/null <<UNIT
[Unit]
Description=Curious Files video automation
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=15
StandardOutput=append:$APP_DIR/logs/service.log
StandardError=append:$APP_DIR/logs/service.log

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now curious-files.service
sleep 8
curl -fsS http://127.0.0.1:3456/api/readiness >/dev/null && echo "==> App is running on 127.0.0.1:3456" || { echo "App did not start; see logs/service.log"; exit 1; }
echo "Next: install Tailscale (curl -fsSL https://tailscale.com/install.sh | sh; sudo tailscale up), then: sudo tailscale serve --bg 3456"
