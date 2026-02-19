#!/usr/bin/env bash
# Monitor B5 logs on D3. Usage: ./deploy/monitor-b5.sh [lines]
# Optional: pass a number to show last N lines then follow (default: 0, just follow).

D3_IP="${D3_IP:-164.92.210.132}"
LINES="${1:-0}"

if [[ "$LINES" =~ ^[0-9]+$ ]] && [[ "$LINES" -gt 0 ]]; then
  ssh -o ConnectTimeout=10 root@${D3_IP} "journalctl -u cursorbot-b5 -n ${LINES} -f"
else
  ssh -o ConnectTimeout=10 root@${D3_IP} "journalctl -u cursorbot-b5 -f"
fi
