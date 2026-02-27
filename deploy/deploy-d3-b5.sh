#!/bin/sh
# Run this FROM YOUR MAC (or any machine with SSH to D3).
# Prereqs: .env.d3 exists in project root (POLYMARKET_*, HTTPS_PROXY, etc.). SUPABASE_* can be in .env.d3 or added on D3 (needed for B5 position logging).
# We MERGE .env.d3 into D3's .env (update keys that exist in .env.d3; leave other keys on D3 unchanged). So D3's Supabase vars are never wiped by deploy.
# Usage: ./deploy/deploy-d3-b5.sh [D3_IP]

set -e
D3_IP="${1:-164.92.210.132}"
REPO="${REPO:-https://github.com/Jodan-sama/CURSORBOT.git}"

echo "=== Ensuring repo on D3 and merging .env (do not overwrite D3-only vars) ==="
ssh -o StrictHostKeyChecking=no "root@${D3_IP}" "
  if [ ! -d /root/cursorbot/.git ]; then
    cd /root && rm -rf cursorbot 2>/dev/null; git clone $REPO cursorbot && cd cursorbot
  fi
"
# Copy .env.d3 to D3 as .env.merge; then on D3 merge into .env (keys in .env.merge update .env, other keys in .env stay)
if [ -f .env.d3 ]; then
  scp -o StrictHostKeyChecking=no .env.d3 "root@${D3_IP}:/root/cursorbot/.env.merge"
  ssh -o StrictHostKeyChecking=no "root@${D3_IP}" "
    cd /root/cursorbot
    if [ ! -f .env ]; then
      cp .env.merge .env
      echo 'Created .env from .env.merge (first-time).'
    else
      while IFS= read -r line || [ -n \"\$line\" ]; do
        key=\$(echo \"\$line\" | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p')
        [ -z \"\$key\" ] && continue
        grep -v \"^\\\${key}=\" .env > .env.tmp 2>/dev/null || true
        mv .env.tmp .env
        echo \"\$line\" >> .env
      done < .env.merge
      echo 'Merged .env.merge into .env (D3-only keys like SUPABASE_* preserved).'
    fi
    rm -f .env.merge
  "
  ssh -o StrictHostKeyChecking=no "root@${D3_IP}" "
    cd /root/cursorbot
    if [ -f .env ]; then
      has_supabase=0
      grep -q '^SUPABASE_URL=' .env 2>/dev/null && grep -q '^SUPABASE_ANON_KEY=' .env 2>/dev/null && has_supabase=1
      if [ \"\$has_supabase\" = 1 ]; then
        echo 'D3 .env: SUPABASE_URL and SUPABASE_ANON_KEY present.'
      else
        echo 'WARN: D3 .env missing SUPABASE_URL or SUPABASE_ANON_KEY. Add them on D3 for B5 position logging.'
      fi
    fi
  "
fi

echo "=== Build and start B5 (spread only) on D3 ==="
ssh -o StrictHostKeyChecking=no "root@${D3_IP}" "
  set -e
  cd /root/cursorbot
  git pull origin main || true
  npm install && npm run build
  cp deploy/cursorbot-b5-spread.service /etc/systemd/system/
  cp deploy/cursorbot-claim-b5.service deploy/cursorbot-claim-b5.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl stop cursorbot-b5 2>/dev/null || true
  systemctl disable cursorbot-b5 2>/dev/null || true
  systemctl enable --now cursorbot-b5-spread
  systemctl enable --now cursorbot-claim-b5.timer
  (crontab -l 2>/dev/null | grep -v cursorbot-claim-b5 || true) | crontab - 2>/dev/null || true
  systemctl status cursorbot-b5-spread --no-pager
  echo ''
  echo 'Claim timer (persist across reboot):'
  systemctl list-timers cursorbot-claim-b5.timer --no-pager 2>/dev/null || true
  echo ''
  echo 'B5 (spread): journalctl -u cursorbot-b5-spread -f'
  echo 'B5 claim: journalctl -u cursorbot-claim-b5.service -f'
"
