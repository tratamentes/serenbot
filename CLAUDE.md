# SerenBot — Manual para IA

> Documento vivo. Actualizar após cada sessão de trabalho que mude a arquitectura.
> Última revisão: 2026-04-29

---

## O que é isto

SerenBot é uma API Node.js que serve de ponte entre o agente OpenClaw (IA de conversação) e os serviços externos: **Cal.eu** (agendamentos), **Kommo CRM** (gestão de clientes e leads) e **Telegram** (notificações ao admin).

Não é um bot autónomo — é o backend que o agente invoca via HTTP quando precisa de agendar, consultar disponibilidade, registar um cliente, ou notificar o prestador.

---

## Arquitectura

```
Telegram / WhatsApp
        │
        ▼
  OpenClaw Gateway (localhost:18789)
        │
        ▼
  OpenClaw Agent "cliente"  ←──► OpenRouter Proxy (localhost:3002) [opcional]
        │
        ▼
  SerenBot API (localhost:3001)   ←── EnvironmentFile: /opt/serenbot/.env
     │         │         │
     ▼         ▼         ▼
  Cal.eu    Kommo CRM  Telegram Bot B
  (agenda)  (leads)    (notifica admin)
```

**Zero portas expostas** — tudo chega via Cloudflare Tunnel:
- `bots.tratamentes.pt` → localhost:18789 (OpenClaw Gateway)
- `api.tratamentes.pt`  → localhost:3001  (SerenBot API)

---

## Ficheiros principais

| Ficheiro | Responsabilidade |
|---|---|
| `src/api.js` | Express app, todos os endpoints, ponto de entrada |
| `src/infra/calcom.js` | Cal.eu v2 API — slots, reservas, cancelamentos |
| `src/infra/kommo.js` | Kommo CRM — contacts, leads, pipeline moves |
| `src/infra/notify.js` | Notificações Telegram para o admin (Bot B) |
| `src/infra/geocoding.js` | Geocoding via Nominatim, cálculo de distância ao domicílio |
| `src/infra/webhook.js` | Processamento de webhooks Cal.eu (CREATED/RESCHEDULED/CANCELLED) |
| `src/infra/event-types-cache.js` | Cache em memória dos event types Cal.eu |
| `src/core/models.js` | Modelo unificado `UnifiedBooking` (normaliza respostas Cal.eu) |
| `src/core/slots.js` | Lógica de negócio para slots disponíveis |
| `src/core/domicilio.js` | Lógica de negócio para sessões ao domicílio |
| `src/cache/geocache.js` | Cache persistente de geocoding (SQLite/JSON/memória) |
| `src/utils/http.js` | HTTP client sobre fetch nativo (Node 18+) |
| `src/utils/logger.js` | Logger simples com timestamp e nível |
| `src/utils/phone.js` | Normalização de números de telefone |
| `src/utils/time.js` | Utilitários de timezone (Lisboa) |
| `src/utils/graph-context.js` | Carrega knowledge graph para contexto do agente |
| `src/openrouter-proxy.js` | Proxy para OpenRouter (bypass Presidio PII redaction) |

---

## Endpoints da API

### Públicos (requerem `Authorization: Bearer $API_TOKEN`)

| Método | Path | Params chave | O que faz |
|---|---|---|---|
| GET | `/health` | — | Health check |
| GET | `/availability` | `eventTypeId`, `date` (YYYY-MM-DD) | Slots disponíveis Cal.eu |
| GET | `/context` | — | Knowledge graph para contexto do agente |
| GET | `/client` | `phone` | Buscar cliente Kommo por telefone |
| GET | `/bookings` | `eventTypeId`, `startTime`, `endTime` | Reservas Cal.eu |
| GET | `/bookings-by-date` | `date` | Reservas por data |
| GET | `/distance` | `address` | Distância geocodificada ao prestador |
| GET | `/domicilio-check` | `address` | Verifica elegibilidade ao domicílio |
| GET | `/whatsapp-ping` | `sender`, `name` | Notifica admin quando cliente WhatsApp inicia conversa |
| GET | `/telegram-ping` | `sender`, `name`, `username` | Notifica admin quando cliente Telegram inicia conversa |
| POST | `/booking` | body JSON | Criar reserva Cal.eu + registar Kommo |
| POST | `/reschedule` | body JSON | Reagendar reserva Cal.eu |
| POST | `/cancel` | body JSON | Cancelar reserva Cal.eu |
| POST | `/notify-paulo` | body JSON | Enviar notificação directa ao admin |

### Webhooks (requerem `X-Cal-Signature-256` HMAC — `$WEBHOOK_SECRET`)

| Método | Path | Origem |
|---|---|---|
| POST | `/webhook/caleu` | Cal.eu → notifica admin, move lead Kommo |

### Admin (requerem API_TOKEN)

| Método | Path | O que faz |
|---|---|---|
| POST | `/admin/refresh-event-types` | Força reload da cache de event types Cal.eu |
| GET | `/admin/sessions` | Lista sessões OpenClaw activas (HTML) |

---

## Configuração — variáveis de ambiente

Ficheiro: `/opt/serenbot/.env` (chmod 600, root:root)

### Obrigatórias para funcionar

| Variável | Valor actual | Origem |
|---|---|---|
| `KOMMO_SUBDOMAIN` | `joaogoulart` | URL da conta Kommo |
| `KOMMO_ACCESS_TOKEN` | JWT longo | Kommo → Integrações → OAuth |
| `KOMMO_RESPONSIBLE_USER_ID` | `14608143` | JWT sub / GET /api/v4/users |
| `KOMMO_PIPELINE_ID` | `12907567` | Funil de Vendas — GET /api/v4/leads/pipelines |
| `KOMMO_PIPELINE_ATIVOS_ID` | `12990767` | Clientes Ativos — idem |
| `KOMMO_STATUS_AGENDADO` | `99528395` | Stage AGENDADO funil principal |
| `KOMMO_STATUS_ATIVOS_AGENDADO` | `100167911` | Stage AGENDADO funil ativos |
| `API_TOKEN` | `511ff6...` | Gerado em setup, protege endpoints |
| `WEBHOOK_SECRET` | `noa2026tratamentes` | HMAC para webhooks Cal.eu |
| `TELEGRAM_BOT_B_TOKEN` | `8726268422:...` | suporte_tratamentes_bot |

### Por preencher

| Variável | O que é | Como obter |
|---|---|---|
| `CALCOM_API_KEY` | Bearer token Cal.eu | app.cal.eu → Settings → API Keys |
| `CALCOM_USERNAME` | Slug do calendário | URL do perfil Cal.eu |
| `TELEGRAM_ADMIN_ID` | Chat ID do João | Enviar `/start` ao bot → @userinfobot |
| `OPENROUTER_API_KEY` | Key OpenRouter | openrouter.ai → Keys (opcional) |

---

## IDs Kommo hardcoded em `src/infra/kommo.js`

Estes IDs são específicos da conta `joaogoulart.kommo.com` e **não mudam** a menos que sejam apagados/recriados no Kommo.

- `STAGE` — IDs dos stages em cada pipeline (confirmados via API 2026-04-29)
- `FIELD` — IDs dos campos customizados de contacts e leads
- `ENUM` — IDs dos valores enum de cada campo

Para consultar/validar:
```bash
curl -s "https://joaogoulart.kommo.com/api/v4/leads/pipelines" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" | python3 -m json.tool

curl -s "https://joaogoulart.kommo.com/api/v4/contacts/custom_fields" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" | python3 -m json.tool
```

---

## Serviços systemd

| Serviço | Comando | Estado |
|---|---|---|
| `serenbot-api` | `node src/api.js` | instalado e a correr na porta **3002** (2026-04-29) |
| `serenbot-proxy` | `node src/openrouter-proxy.js` | não instalado (falta OPENROUTER_API_KEY) |

```bash
sudo systemctl status serenbot-api
sudo journalctl -u serenbot-api -f
```

---

## Estado das integrações (2026-04-29)

| Integração | Estado | Notas |
|---|---|---|
| Kommo CRM | ✅ Token válido, IDs confirmados via API | Expira 2026-06-29 |
| Telegram Bot B | ✅ Token presente | TELEGRAM_ADMIN_ID em falta |
| Cal.eu | ⚠️ Chaves em falta | CALCOM_API_KEY e CALCOM_USERNAME por preencher |
| OpenRouter | ⚠️ Chave em falta | Proxy não instalado |
| Geocoding | ✅ Nominatim, sem chave necessária | Cache SQLite em data/geocache.db |

---

## Como testar cada integração

```bash
# 1. Health check
curl -s http://localhost:3002/health
# esperado: {"status":"ok"}

# 2. Kommo — buscar cliente (testa token + subdomain)
curl -s "http://localhost:3002/client?phone=351912345678" \
  -H "Authorization: Bearer $API_TOKEN"
# esperado: {"found":false} ou dados do cliente

# 3. Cal.eu — disponibilidade (requer CALCOM_API_KEY preenchido)
curl -s "http://localhost:3002/availability?eventTypeId=XXX&date=2026-05-05" \
  -H "Authorization: Bearer $API_TOKEN"

# 4. Telegram — verificar bot (directo à API Telegram)
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_B_TOKEN/getMe"
# esperado: {"ok":true,"result":{"username":"suporte_tratamentes_bot",...}}

# 5. Telegram — obter ADMIN_ID (envia mensagem ao bot e usa getUpdates)
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_B_TOKEN/getUpdates"

# 6. Logs em tempo real
sudo journalctl -u serenbot-api -f
```

---

## Notas de manutenção

- **Token Kommo expira**: 2026-06-29 — renovar em Kommo → Integrações antes dessa data
- **Geocache**: persiste em `data/geocache.db`, TTL 90 dias, limpa automaticamente no arranque
- **Sessions OpenClaw**: em `~/.openclaw/agents/cliente/sessions/`
- **Logs**: `sudo journalctl -u serenbot-api --since today`
