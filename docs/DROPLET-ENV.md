# Fill .env on the droplet

The bot is installed and the service is running, but it will keep exiting until `.env` has your real credentials.

**SSH in and edit .env:**

```bash
ssh root@188.166.15.165
nano /root/cursorbot/.env
```

Fill in every value (Kalshi key ID and private key, Supabase URL and anon key, Polymarket private key/funder/API key/secret/passphrase, and the proxy lines with one of your session IDs). Save: `Ctrl+O`, Enter, `Ctrl+X`.

**Restart the bot:**

```bash
sudo systemctl restart cursorbot
sudo systemctl status cursorbot
```

**View logs:**

```bash
sudo journalctl -u cursorbot -f
```

Exit logs with `Ctrl+C`.
