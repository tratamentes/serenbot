# SerenBot

> OpenClaw-powered booking assistant for wellness & service businesses.  
> Telegram + WhatsApp · Cloudflare Tunnels · Cal.eu · Kommo CRM

---

## What is this?

SerenBot is a setup wizard that installs and configures an AI booking assistant on your VPS in minutes.

Built on [OpenClaw](https://openclaw.ai), it deploys one or two AI agents (e.g. a customer-facing bot and an admin bot) with:

- **Zero open ports** — everything runs through Cloudflare Tunnels
- **Telegram + WhatsApp** support via OpenClaw connectors
- **Secure credentials** — `.env` with `chmod 600`, outside the web root, never committed
- **systemd services** — auto-restart on failure
- **Resumable install** — interrupt and continue where you left off

Works alongside an existing Nginx/PHP/SQLite stack without conflicts.

---

## Quick start

```bash
git clone https://github.com/tratamentes/serenbot.git
cd serenbot
bash scripts/setup.sh
```

The wizard will ask for:
1. A project name (used for folder, tunnel name, systemd services)
2. Agent names and whether sandbox is ON or OFF per agent
3. API tokens one by one (hidden input)
4. WhatsApp mode (OpenClaw CLI or external service)

To install only one agent:
```bash
bash scripts/setup.sh --only agent1
```

---

## Requirements

- Ubuntu 22.04+ or Debian 12+
- 1 GB RAM, 10 GB disk
- SSH access (root or sudo)
- A domain on Cloudflare (for the tunnel)
- Anthropic API key

Optional integrations: Cal.eu, Kommo CRM.

---

## Architecture

```
Internet
   │
Cloudflare Tunnel
   ├──► bots.your-domain.com  →  localhost:18789  (OpenClaw Gateway)
   └──► api.your-domain.com   →  localhost:3001   (Node.js API)
```

No ports are exposed publicly. Cloudflare handles TLS end-to-end.

---

## Documentation

See [`docs/INSTALL.md`](docs/INSTALL.md) for the full step-by-step guide, manual installation, troubleshooting, and security notes.

---

## License

MIT
