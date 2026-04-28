# Guia de Instalação — OpenClaw Bot System

> Última revisão: 2026-04-28  
> Stack: OpenClaw · Cloudflare Tunnels · Telegram/WhatsApp · (Cal.eu · Kommo opcionais)

---

## O que preciso saber antes de começar

### Requisitos do servidor
- Ubuntu 22.04+ / Debian 12+ com acesso root ou sudo
- 1 GB RAM (2 GB recomendado), 10 GB disco
- Acesso SSH

### O que NÃO é necessário abrir no firewall
Tudo corre via **Cloudflare Tunnels**. Zero portas expostas.  
O servidor só precisa de sair para a internet (outbound).

### Tokens que vais precisar

| Token | Onde obter |
|---|---|
| Anthropic API Key | console.anthropic.com → API Keys |
| Cloudflare Account ID | dash.cloudflare.com → perfil → Account ID |
| Cloudflare API Token | dash.cloudflare.com → My Profile → API Tokens (Tunnel:Edit + DNS:Edit) |
| Telegram Bot Token (por agente) | Telegram → @BotFather → /newbot |
| Cal.eu API Key (se usares) | app.cal.eu → Settings → API Keys |
| Kommo API Key (se usares) | app.kommo.com → Integrações → API |

### Sobre o WhatsApp
- **Via OpenClaw CLI** — usa WhatsApp Web interno, volume baixo, sem conta business
- **Via serviço externo** (Z-API, Evolution API) — volume alto ou conta business verificada

O wizard pergunta qual preferes. Em caso de dúvida: OpenClaw CLI.

---

## Arquitectura

```
Internet
   │
   ▼
Cloudflare Tunnel (cloudflared daemon)
   │
   ├──► localhost:18789  (OpenClaw Gateway — todos os bots)
   │         ├── Agente 1 (ex: clientes, sandbox ON)
   │         └── Agente 2 (ex: admin, sandbox OFF)
   │
   └──► localhost:3001   (API Node.js — Cal.eu, Kommo, webhooks)

Nginx/PHP existente não interfere — corre em paralelo.
```

Nenhuma porta exposta publicamente. Cloudflare valida e encaminha tudo.

---

## Instalação automática (recomendado)

```bash
git clone https://github.com/tratamentes/serenbot.git && cd serenbot
bash scripts/setup.sh
```

O script é interactivo. Vai perguntar:
1. Nome do projecto (usado em pasta, tunnel, serviços systemd)
2. Nomes dos agentes e se sandbox está ON/OFF
3. Tokens/credenciais um a um (input oculto)
4. Modo WhatsApp

Podes interromper e retomar — o script guarda o estado em `/tmp/.openclaw_setup_state`.

Para instalar só um agente:
```bash
bash scripts/setup.sh --only agent1
```

---

## Instalação manual passo a passo

### 1 — Instalar OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
openclaw --version
```

### 2 — Instalar cloudflared

```bash
# Detectar arquitectura
ARCH=$(uname -m)
[[ "$ARCH" == "x86_64" ]] && CF_ARCH="amd64" || CF_ARCH="arm64"

curl -L -o /tmp/cloudflared.deb \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}.deb"
sudo dpkg -i /tmp/cloudflared.deb
cloudflared --version
```

### 3 — Autenticar e criar tunnel

```bash
# Autenticar (abre URL — em VPS copia e abre no browser local)
cloudflared tunnel login

# Criar tunnel (substitui <nome> pelo nome do teu projecto)
cloudflared tunnel create <nome>
cloudflared tunnel list   # copia o UUID
```

### 4 — Configurar tunnel

Cria `/etc/cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /root/.cloudflared/<UUID>.json

ingress:
  - hostname: bots.teu-dominio.com
    service: http://localhost:18789
  - hostname: api.teu-dominio.com
    service: http://localhost:3001
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <nome> bots.teu-dominio.com
cloudflared tunnel route dns <nome> api.teu-dominio.com
```

### 5 — Criar .env

```bash
sudo mkdir -p /opt/<nome-projecto>
sudo tee /opt/<nome-projecto>/.env > /dev/null << 'EOF'
ANTHROPIC_API_KEY=sk-ant-...
CAL_EU_API_KEY=...
KOMMO_API_KEY=...
KOMMO_ACCOUNT_URL=https://empresa.kommo.com
CF_DOMAIN=teu-dominio.com
TELEGRAM_TOKEN_AGENT1=...
TELEGRAM_TOKEN_AGENT2=...
GATEWAY_PORT=18789
API_PORT=3001
NODE_ENV=production
EOF

sudo chmod 600 /opt/<nome-projecto>/.env
```

### 6 — Inicializar agentes

```bash
openclaw agent init agent1 --workspace ~/.openclaw/workspace-agent1 --sandbox on
openclaw agent init agent2 --workspace ~/.openclaw/workspace-agent2 --sandbox off
```

### 7 — Serviços systemd

```bash
# Gateway OpenClaw
sudo tee /etc/systemd/system/<nome>-gateway.service << EOF
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
User=$USER
WorkingDirectory=$(pwd)
EnvironmentFile=/opt/<nome>/.env
ExecStartPre=openclaw gateway stop --quiet || true
ExecStart=openclaw gateway start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# API Node.js
sudo tee /etc/systemd/system/<nome>-api.service << EOF
[Unit]
Description=<nome> API
After=network.target

[Service]
User=$USER
WorkingDirectory=$(pwd)
EnvironmentFile=/opt/<nome>/.env
ExecStart=node src/api.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo cloudflared service install
sudo systemctl daemon-reload
sudo systemctl enable <nome>-gateway <nome>-api cloudflared
sudo systemctl start <nome>-gateway <nome>-api cloudflared
```

### 8 — Configurar webhooks

**Cal.eu** — app.cal.eu → Settings → Webhooks:
- URL: `https://api.teu-dominio.com/webhook/cal`
- Events: `BOOKING_CREATED`, `BOOKING_CANCELLED`, `BOOKING_RESCHEDULED`

**Kommo** — app.kommo.com → Integrações → Webhooks:
- URL: `https://api.teu-dominio.com/webhook/kommo`

---

## Verificação

```bash
# Serviços
systemctl status <nome>-gateway <nome>-api cloudflared

# Health checks locais
curl http://localhost:18789/health
curl http://localhost:3001/health

# Health check via tunnel (de fora)
curl https://bots.teu-dominio.com/health
```

---

## Troubleshooting

| Sintoma | Causa | Solução |
|---|---|---|
| Bot responde <2s sem fazer nada | Modelo não chamou tools | Ver `~/.openclaw/agents/*/sessions/*.trajectory.jsonl` — confirmar `toolMetas` |
| `toolMetas: []` no trajectory | `tools.allow` incompleto | Adicionar `read`, `write`, `web_fetch` ao allowlist |
| Webhook não chega | Tunnel em baixo | `systemctl restart cloudflared` |
| Agente acede ao host incorrectamente | Docker bridge IP errado | De dentro de sandbox usar `172.17.0.1:3001` (não `127.0.0.1`) |
| Porta 18789 ocupada ao iniciar | Gateway anterior não saiu | `openclaw gateway stop` antes de `start` |
| Cal.eu retorna `[]` | Versão API errada | Bookings → `2024-08-13`; slots → `2024-09-04` |

---

## Segurança

- `.env` com `chmod 600` em `/opt/<nome>/` — fora do web root, fora do repo git
- Zero portas abertas no firewall — exclusivamente via Cloudflare Tunnel
- Cloudflare valida TLS end-to-end
- Agentes com `sandbox on` não têm acesso ao sistema de ficheiros do host
