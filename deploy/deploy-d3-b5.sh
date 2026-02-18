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
  systemctl daemon-reload
  systemctl enable --now cursorbot-b5
  (crontab -l 2>/dev/null | grep -v cursorbot-claim-b5; echo '0,5,10,15,20,25,30,35,40,45,50,55 * * * * cd /root/cursorbot && DOTENV_CONFIG_PATH=.env /usr/bin/node dist/scripts/claim-polymarket.js >> /var/log/cursorbot-claim-b5.log 2>&1') | crontab -
  systemctl status cursorbot-b5 --no-pager
  echo ''
  echo 'Done. Logs: journalctl -u cursorbot-b5 -f'
"
