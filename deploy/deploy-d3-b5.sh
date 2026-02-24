#!/bin/sh
# Run this FROM YOUR MAC (or any machine with SSH to D3).
# Prereqs: .env.d3 exists in project root; set HTTPS_PROXY in .env.d3 if needed.
# Usage: ./deploy/deploy-d3-b5.sh [D3_IP]

set -e
D3_IP="${1:-164.92.210.132}"
REPO="${REPO:-https://github.com/Jodan-sama/CURSORBOT.git}"

echo "=== Ensuring repo on D3 and copying .env ==="
ssh -o StrictHostKeyChecking=no "root@${D3_IP}" "
  if [ ! -d /root/cursorbot/.git ]; then
    cd /root && rm -rf cursorbot 2>/dev/null; git clone $REPO cursorbot && cd cursorbot
  fi
"
scp -o StrictHostKeyChecking=no .env.d3 "root@${D3_IP}:/root/cursorbot/.env"

echo "=== Build and start B5 on D3 ==="
ssh -o StrictHostKeyChecking=no "root@${D3_IP}" "
  set -e
  cd /root/cursorbot
  git pull origin main || true
  npm install && npm run build
  cp deploy/cursorbot-b5.service /etc/systemd/system/
  cp deploy/cursorbot-b5-spread.service /etc/systemd/system/ 2>/dev/null || true
  cp deploy/cursorbot-claim-b5.service deploy/cursorbot-claim-b5.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now cursorbot-b5
  systemctl restart cursorbot-b5-spread 2>/dev/null || true
  systemctl enable --now cursorbot-claim-b5.timer
  (crontab -l 2>/dev/null | grep -v cursorbot-claim-b5 || true) | crontab - 2>/dev/null || true
  systemctl status cursorbot-b5 --no-pager
  systemctl status cursorbot-b5-spread --no-pager 2>/dev/null || true
  echo ''
  echo 'Claim timer (persist across reboot):'
  systemctl list-timers cursorbot-claim-b5.timer --no-pager 2>/dev/null || true
  echo ''
  echo 'Done. B5 basket: journalctl -u cursorbot-b5 -f'
  echo 'B5 spread: journalctl -u cursorbot-b5-spread -f'
  echo 'B5 claim: journalctl -u cursorbot-claim-b5.service -f'
"
