# Droplet read-only key (for private repo)

The droplet needs to **clone** and **pull** from GitHub. A read-only deploy key is already on the droplet.

**Add this key to the repo (read-only is enough):**

1. GitHub → **Jodan-sama/CURSORBOT** → **Settings** → **Deploy keys** → **Add deploy key**
2. **Title:** `Droplet (read-only)`
3. **Key:** paste this entire line (do **not** check “Allow write access”):
   ```
   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBhKRsLYTbNGY3O/2Q1yEZqBVZpDDs1vS7naGQ3QV0QJ cursorbot-droplet-read
   ```
4. **Add key**

After you add it, tell me and I’ll run the clone and finish the droplet setup.

**Alternative:** Make the repo **public**; then the droplet can clone via HTTPS with no key. You can switch it back to private later and add this key then.
