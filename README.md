# SerenBot

> Bot de agendamento autónomo para a clínica Tratamentes.  
> Telegram · Cal.com · Kommo CRM · Cloudflare Tunnels

---

## O que é

SerenBot é uma API Node.js com dois papéis:

1. **Seren Lite** — bot Telegram nativo (state machine + keywords). Recebe mensagens de clientes via webhook, classifica intenção, gere o fluxo de conversa e agenda directamente no Cal.com. **Sem LLM por mensagem** — rápido e de custo zero por interacção.
2. **Backend API** — endpoints HTTP para Cal.com, Kommo CRM, notificações admin e administração.

```
Cliente Telegram
      │  POST /telegram/seren
      ▼
SerenBot API (localhost:3002)
  src/bot/seren-handler.js   ←── state machine + keyword intent
     │         │         │
     ▼         ▼         ▼
  Cal.com   Kommo CRM  Notificações
  (agenda)  (leads)    (admin via Telegram)
```

---

## Stack

- **Node.js 18+** / Express
- **Cal.com v2 API** — agendamento
- **Kommo CRM** — gestão de leads
- **Telegram Bot API** — webhook nativo (sem gateway intermédio)
- **OpenRouter** — Gemini Flash como fallback LLM para intenções desconhecidas
- **Cloudflare Tunnel** — zero portas abertas no firewall
- **Nominatim / OSM** — geocoding para serviços ao domicílio (cache SQLite)

---

## Quick start

```bash
git clone https://github.com/tratamentes/serenbot.git
cd serenbot
bash scripts/setup.sh
```

O wizard interactivo configura:
1. `.env` com todas as credenciais
2. Serviço systemd `serenbot-api`
3. Cloudflare Tunnel (se aplicável)
4. Webhook Telegram

---

## Requisitos

- Ubuntu 22.04+ ou Debian 12+
- Node.js 18+ (`engines.node` definido em `package.json`)
- 512 MB RAM (1 GB recomendado)
- Domínio no Cloudflare (para o tunnel)

Integrações opcionais: Cal.com, Kommo CRM.

---

## Arquitectura de ficheiros

```
src/
  api.js                  ← Express app, todos os endpoints
  bot/
    seren-handler.js      ← state machine principal (14 estados)
    intent.js             ← classificador de intenções por keywords
    session.js            ← sessões em memória (TTL 30min)
    ab-responses.js       ← variantes A/B/C de respostas
    followup.js           ← follow-ups automáticos (60min/23h/24h)
    llm-fallback.js       ← fallback Gemini Flash (intenções desconhecidas)
  infra/
    calcom.js             ← Cal.com v2 API
    calcom-catalog.js     ← catálogo dinâmico de slugs
    kommo.js              ← Kommo CRM
    notify.js             ← notificações Telegram ao admin
    webhook.js            ← webhooks Cal.com
  core/
    slots.js              ← algoritmo de selecção de slots
    domicilio.js          ← preços ao domicílio por zona
    models.js             ← UnifiedBooking (normaliza Cal.com)
  cache/
    geocache.js           ← cache SQLite (TTL 90 dias)

data/
  sources.json            ← serviços, durações, slugs Cal.com (editável)
  intents.json            ← padrões de intenção (editável sem restart)
  responses.json          ← textos de resposta com variantes (editável sem restart)
```

---

## Documentação

Ver [`docs/INSTALL.md`](docs/INSTALL.md) para guia de instalação, configuração manual e troubleshooting.

---

## License

MIT
