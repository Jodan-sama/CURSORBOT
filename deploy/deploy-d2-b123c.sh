#!/bin/sh
# Deploy B123c (and optionally B4) to D2. Run from project root (e.g. from Mac with SSH to D2).
# Usage: ./deploy/deploy-d2-b123c.sh [D2_IP]

set -e
D2_IP="${1:-161.35.149.219}"

echo "=== Deploying to D2 (${D2_IP}): pull, build, restart cursorbot-b123c ==="
ssh -o StrictHostKeyChecking=no "root@${D2_IP}" "
  set -e
  cd /root/cursorbot
  git pull origin main
  npm run build
  systemctl restart cursorbot-b123c
  systemctl status cursorbot-b123c --no-pager
  echo ''
  echo 'Done. B123c logs: journalctl -u cursorbot-b123c -f'
"
