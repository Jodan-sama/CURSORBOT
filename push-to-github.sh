#!/usr/bin/env bash
# Push to GitHub using the project deploy key (so Cursor/Vercel deploy works).
# Run from repo root: ./push-to-github.sh
set -e
cd "$(dirname "$0")"
KEY="$(pwd)/.ssh/github_deploy"
if [[ ! -f "$KEY" ]]; then
  echo "Missing deploy key: $KEY" >&2
  exit 1
fi
GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no" git push origin main
echo "Pushed to origin/main."
