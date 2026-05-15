# Guia de Instalação — SerenBot

> Última revisão: 2026-05-02  
> Stack: Node.js · Telegram webhook nativo · Cal.com · Kommo · Cloudflare Tunnels

---

## Requisitos

- Ubuntu 22.04+ / Debian 12+ com acesso root ou sudo
- 512 MB RAM (1 GB recomendado), 5 GB disco
- Acesso SSH

### Credenciais necessárias

| Credencial | Onde obter |
|---|---|
| Telegram Bot Token (Seren) | @BotFather → /newbot |
| Telegram Bot Token (notificações admin) | @BotFather → /newbot (bot separado) |
| Telegram Admin ID | Enviar msg a @userinfobot |
| Cal.com API Key | cal.com → Settings → API Keys |
| Kommo Access Token | joaogoulart.kommo.com → Integrações → API |
| OpenRouter API Key | openrouter.ai → Keys ou BYOK; opcional para classificar mensagens ambíguas |
| Cloudflare Account ID + API Token | dash.cloudflare.com |

---

## Instalação automática (recomendado)

```bash
git clone https://github.com/tratamentes/serenbot.git
cd serenbot
bash scripts/setup.sh
```

O script pede as credenciais uma a uma, cria o `.env`, instala o serviço systemd e configura o webhook Telegram. Podes interromper e retomar — o estado é guardado em `/tmp/.serenbot_setup_state`.

---

## Instalação manual passo a passo

### 1 — Instalar Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash -
sudo apt-get install -y nodejs
node --version  # deve ser >= 18
```

### 2 — Instalar dependências

```bash
cd /home/joao/serenbot   # ou onde clonaste o repo
npm install --production
```

### 3 — Criar ficheiro .env

```bash
sudo mkdir -p /opt/serenbot
sudo cp .env.example /opt/serenbot/.env
sudo chmod 600 /opt/serenbot/.env
sudo nano /opt/serenbot/.env  # preencher todos os campos <REQUIRED>
```

Campos obrigatórios mínimos para arrancar:
- `TELEGRAM_TOKEN_AGENT1` — token do bot Seren
- `TELEGRAM_BOT_B_TOKEN` — token do bot de notificações
- `TELEGRAM_ADMIN_ID` — o teu chat ID
- `TELEGRAM_WEBHOOK_SECRET` — gerar com `openssl rand -hex 32`
- `CALCOM_API_KEY` + `CALCOM_USERNAME`
- `KOMMO_SUBDOMAIN` + `KOMMO_ACCESS_TOKEN` + IDs de pipeline/status
- `API_TOKEN` + `WEBHOOK_SECRET` — gerar com `openssl rand -hex 32`
- `OPENROUTER_API_KEY` é opcional. Se preencheres, só é usado quando `LLM_INTENT_ENABLED=true`.

Configuração recomendada para LLM auxiliar:
- `LLM_INTENT_ENABLED=false` em produção até validares o fluxo
- `LLM_INTENT_MODEL=google/gemini-2.5-flash-lite`
- `LLM_INTENT_MONTHLY_BUDGET_EUR=5`
- `LLM_INTENT_MONTHLY_HARD_LIMIT_EUR=15`

### 4 — Criar serviço systemd

```bash
sudo tee /etc/systemd/system/serenbot-api.service > /dev/null << EOF
[Unit]
Description=SerenBot API
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
EnvironmentFile=/opt/serenbot/.env
ExecStart=$(which node) src/api.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable serenbot-api
sudo systemctl start serenbot-api
sudo systemctl status serenbot-api
```

### 5 — Instalar cloudflared

```bash
ARCH=$(uname -m)
[[ "$ARCH" == "x86_64" ]] && CF_ARCH="amd64" || CF_ARCH="arm64"
curl -L -o /tmp/cloudflared.deb \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}.deb"
sudo dpkg -i /tmp/cloudflared.deb
cloudflared --version
```

### 6 — Criar Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create serenbot
cloudflared tunnel list   # anotar UUID
```

Criar `/etc/cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /root/.cloudflared/<UUID>.json

ingress:
  - hostname: api.teu-dominio.com
    service: http://localhost:3002
  - service: http_status:404
```

```bash
cloudflared tunnel route dns serenbot api.teu-dominio.com
sudo cloudflared service install
sudo systemctl start cloudflared
```

### 7 — Registar webhook Telegram

```bash
# Substituir TOKEN e WEBHOOK_SECRET pelos valores do .env
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.teu-dominio.com/telegram/seren",
    "secret_token": "<WEBHOOK_SECRET>"
  }'

# Verificar
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### 8 — Configurar webhook Cal.com

No painel Cal.com → Settings → Webhooks:
- URL: `https://api.teu-dominio.com/webhook/caleu`
- Secret: valor de `WEBHOOK_SECRET` do `.env`
- Events: `BOOKING_CREATED`, `BOOKING_CANCELLED`, `BOOKING_RESCHEDULED`

---

## Verificação

```bash
# Serviço a correr
sudo systemctl status serenbot-api
sudo journalctl -u serenbot-api --since today

# Health check local
curl http://localhost:3002/health
# → {"status":"ok"}

# Catálogo Cal.com carregado
curl -H "x-api-token: $API_TOKEN" http://localhost:3002/admin/catalog | jq '.catalog | keys'
```

---

## Troubleshooting

| Sintoma | Causa provável | Solução |
|---|---|---|
| Bot não responde | Webhook não registado ou URL errada | `getWebhookInfo` — verificar URL e pending_update_count |
| Webhook Telegram retorna 403 | `TELEGRAM_WEBHOOK_SECRET` não coincide | Confirmar que é o mesmo valor no `.env` e no `setWebhook` |
| Webhook Cal.com retorna 401 | `WEBHOOK_SECRET` não coincide | Confirmar valor no painel Cal.com = `.env` |
| Slug não encontrado (fallback relaxamento) | Catálogo desactualizado | `POST /admin/refresh-event-types` |
| Email inválido no Cal.com | `CALCOM_USERNAME` errado | Verificar slug no URL do calendário |
| Serviço não arranca | `.env` não encontrado | Confirmar path em `EnvironmentFile` |

---

## Segurança

- `/opt/serenbot/.env` com `chmod 600` — fora do repo git, fora do web root
- Zero portas expostas publicamente — exclusivamente via Cloudflare Tunnel
- `requireToken` — IPs RFC1918 (localhost) passam sem token; IPs externos requerem `x-api-token`
- `verifyTelegramWebhook` — valida `X-Telegram-Bot-Api-Secret-Token` em todos os updates
- `verifyWebhook` — HMAC SHA-256 para todos os webhooks Cal.com
