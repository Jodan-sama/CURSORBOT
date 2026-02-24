#!/bin/sh
# Deploy B123c (and optionally B4) to D2. Run from project root (e.g. from Mac with SSH to D2).
# Usage: ./deploy/deploy-d2-b123c.sh [D2_IP]

set -e
D2_IP="${1:-161.35.149.219}"

echo "=== Deploying to D2 (${D2_IP}): pull, build, restart B123c + B4-5m, ensure claim crons ==="
ssh -o StrictHostKeyChecking=no "root@${D2_IP}" "
  set -e
  cd /root/cursorbot
  git pull origin main
  npm run build
  systemctl restart cursorbot-b123c
  systemctl restart cursorbot-b4-5m 2>/dev/null || true
  # Claim via systemd timers (persist across reboot; :02,:07,:12,... every 5 min). Remove claim from crontab if present.
  cp deploy/cursorbot-claim-b4.service deploy/cursorbot-claim-b4.timer deploy/cursorbot-claim-b123c.service deploy/cursorbot-claim-b123c.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now cursorbot-claim-b4.timer cursorbot-claim-b123c.timer
  (crontab -l 2>/dev/null | grep -v cursorbot-claim-b4 | grep -v cursorbot-claim-b123c || true) | crontab - 2>/dev/null || true
  systemctl status cursorbot-b123c --no-pager
  systemctl status cursorbot-b4-5m --no-pager 2>/dev/null || true
  echo ''
  echo 'Claim timers (persist across reboot):'
  systemctl list-timers cursorbot-claim-b4.timer cursorbot-claim-b123c.timer --no-pager 2>/dev/null || true
  echo ''
  echo 'Done. B123c: journalctl -u cursorbot-b123c -f'
  echo 'B4: journalctl -u cursorbot-b4-5m -f'
  echo 'B4 claim: journalctl -u cursorbot-claim-b4.service -f'
  echo 'B123c claim: journalctl -u cursorbot-claim-b123c.service -f'
"
