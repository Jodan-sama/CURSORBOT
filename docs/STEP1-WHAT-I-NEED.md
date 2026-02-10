# Step 1 — What I need so I can SSH in and run setup

An SSH key for the droplet is ready in this project. **`.ssh/` is in `.gitignore`**, so the key will never be committed to GitHub.

---

## Why use GitHub here?

We use GitHub so the **droplet can pull your code** with `git clone`. No GitHub credentials are needed on the droplet if the repo is **public**. If the repo is **private**, you’ll either make it public for the droplet or add a deploy key later; for step 1, a public repo is enough.

You don’t need to give me access to your GitHub account. You only push from your machine; I’ll use the droplet and SSH.

---

## What you need to do (3 things)

### 1. Add this SSH key when you create the droplet

Create a new droplet in DigitalOcean (Ubuntu 22.04, 1 GB or 2 GB RAM as discussed).

When DigitalOcean asks for **SSH key**:

- Click **New SSH Key**.
- Paste this **entire line** as the key:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHoycX5F95+uOJ9Z7rXMtD1TADO4V6yUC0hCbg/p63ow cursorbot-droplet
```

- Give it a name (e.g. `Cursorbot droplet`) and save.
- **Select this key** for the droplet and finish creating it.

After creation, note the **droplet IP** (e.g. `164.92.xxx.xxx`).

---

### 2. Push this repo to GitHub (if it’s not there yet)

On your Mac, in the project folder:

```bash
cd /Users/jodan/Documents/CURSORBOT
git init
git add .
git commit -m "Initial cursorbot"
git remote add origin https://github.com/YOUR_USERNAME/CURSORBOT.git
git branch -M main
git push -u origin main
```

Use your real GitHub username and repo name. If the repo already exists, just ensure the latest code is pushed.

---

### 3. Send me these two things

Reply with:

1. **Droplet IP**  
   Example: `164.92.xxx.xxx`

2. **GitHub repo URL** (so I can clone on the droplet)  
   Example: `https://github.com/YourUsername/CURSORBOT`  
   (Public repo is enough; I won’t need any GitHub credentials.)

With that, I’ll SSH in and run: install Node 20 → clone repo → create `.env` (you’ll paste your secrets into `.env` in one go when I ask) → build → systemd service → start the bot.
