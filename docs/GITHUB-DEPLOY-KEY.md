# GitHub deploy key — so I can push for you

A dedicated SSH key for this repo is ready. You add the **public** key to GitHub as a **Deploy key** with **write access**. Then I can push from this project and you (or the droplet) can pull.

---

## What you do (one-time)

1. **Create the repo on GitHub** (if you haven't): [github.com/new](https://github.com/new). Name it e.g. `CURSORBOT`. Don't add a README or .gitignore (we already have them).

2. **Add the deploy key:**
   - Open the repo → **Settings** → **Deploy keys** (under "Security").
   - **Add deploy key**.
   - **Title:** e.g. `Cursorbot (Cursor)`
   - **Key:** paste this **entire line**:
   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHp8YVzGWMAbHLnYWYluqzTbCWdZGLrGVdoVeq9blfbD cursorbot-github-deploy
   ```
   - **Check "Allow write access".**
   - Click **Add key**.

3. **Tell me the repo URL** in one of these forms:
   - `git@github.com:YOUR_USERNAME/CURSORBOT.git`
   - or `https://github.com/YOUR_USERNAME/CURSORBOT`

With that, I'll set `origin` to the repo and push. After that I can push changes whenever you want, and you (or the droplet) can pull with `git pull`.

---

## Droplet

You already created the droplet and added the **droplet** SSH key. IP: **188.166.15.165**.

Once the repo is on GitHub (and the deploy key is added), I can:
1. Push this codebase to the repo.
2. SSH into the droplet and run: install Node → clone repo → `.env` → build → systemd.

Send me the **GitHub repo URL** (e.g. `git@github.com:YourUsername/CURSORBOT.git`) after you've added the deploy key.

---

## Pushing (after deploy key is added)

From the repo root, use the project deploy key so `git push` works (e.g. from Cursor or your machine):

```bash
./push-to-github.sh
```

Or manually:

```bash
GIT_SSH_COMMAND="ssh -i $(pwd)/.ssh/github_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=no" git push origin main
```

Vercel deploys from `main`; the droplet gets updates with `git pull` then rebuild/restart.
