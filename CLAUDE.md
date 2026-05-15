# SerenBot — Manual para IA

> Documento vivo. Actualizar após cada sessão de trabalho que mude a arquitectura.
> Última revisão: 2026-05-03

---

## O que é isto

SerenBot é uma API Node.js com dois papéis:
1. **Seren Lite** — bot Telegram nativo. Recebe mensagens de clientes via webhook, classifica intenção com keywords, gere estado da conversa, agenda via Cal.com. A LLM nunca responde directamente ao cliente; se activada, só classifica mensagens ambíguas em JSON interno.
2. **Backend API** — expõe endpoints HTTP para Cal.com, Kommo CRM, notificações e admin.

---

## Arquitectura

```
Telegram (clientes)
        │  webhook POST /telegram/seren
        ▼
  SerenBot API (localhost:3002)   ←── EnvironmentFile: /opt/serenbot/.env
  src/bot/seren-handler.js         ←── state machine + keyword intent
     │         │         │
     ▼         ▼         ▼
  Cal.com   Kommo CRM  Bot Admin
  (agenda)  (leads)    (notificações via notify.js → TELEGRAM_BOT_B_TOKEN)

Telegram (João — OTP login clinica)
        ↑
  clinicatmotp_bot  ←── /home/tratame3/config.php
```

**Bots Telegram:**
- `suporte_tratamentes_bot` (`8726268422:...`) — **Seren Lite**, webhook nativo em `POST /telegram/seren`
- `TELEGRAM_BOT_B_TOKEN` — **bot de notificações admin**, usado pelo `notify.js` para enviar alertas ao João
- `clinicatmotp_bot` (`8649911217:...`) — apenas envia códigos OTP para login em clinica.tratamentes.pt

**Zero portas expostas** — tudo chega via Cloudflare Tunnel:
- `api.tratamentes.pt` → localhost:3002 (SerenBot API)

---

## Ficheiros principais

| Ficheiro | Responsabilidade |
|---|---|
| `src/api.js` | Express app, todos os endpoints, ponto de entrada |
| `src/bot/seren-handler.js` | State machine principal — recebe updates, gere estados |
| `src/bot/intent.js` | Classificador de intenções por keywords + classifySource |
| `src/bot/intent-analyzer.js` | Combina scoring local + OpenRouter opcional para intenção/sentimento/risco em JSON |
| `src/bot/session.js` | Sessões em memória, TTL 30min |
| `src/bot/ab-responses.js` | Round-robin A/B/C, stats persistidas em data/ab-stats.json |
| `src/bot/followup.js` | Fila de follow-ups (60min, 23h, 24h), persistida em data/followup-queue.json |
| `src/bot/llm-fallback.js` | Compatibilidade antiga; devolve resposta local fixa, sem chamada LLM |
| `src/infra/calcom.js` | Cal.com v2 API — slots, reservas, cancelamentos |
| `src/infra/calcom-catalog.js` | Catálogo dinâmico de slugs Cal.com |
| `src/infra/kommo.js` | Kommo CRM — contacts, leads, pipeline moves |
| `src/infra/notify.js` | Notificações Telegram para o admin (TELEGRAM_BOT_B_TOKEN) |
| `src/infra/geocoding.js` | Geocoding via Nominatim, cálculo de distância ao domicílio |
| `src/infra/webhook.js` | Processamento de webhooks Cal.com (CREATED/RESCHEDULED/CANCELLED) |
| `src/core/models.js` | Modelo unificado `UnifiedBooking` (normaliza respostas Cal.com) |
| `src/core/slots.js` | Lógica de negócio para slots disponíveis |
| `src/core/domicilio.js` | Lógica de preços ao domicílio (base + surcharge por zona) |
| `src/cache/geocache.js` | Cache persistente de geocoding (SQLite) |
| `src/utils/http.js` | HTTP client sobre fetch nativo (Node 18+) |
| `src/utils/logger.js` | Logger simples com timestamp e nível |
| `src/utils/phone.js` | Normalização de números de telefone |
| `src/utils/time.js` | Utilitários de timezone (Lisboa) |
| `data/intents.json` | Padrões de intenção (editável sem restart) |
| `data/responses.json` | Textos de resposta com variantes (reload via POST /admin/responses/reload) |
| `data/sources.json` | Config de serviços: durações, slugs Cal.com, bookingNote |
| `data/calcom-catalog.json` | Catálogo persistido em disco (gerado por calcom-catalog.js) |

---

## calcom-catalog.js — catálogo dinâmico de slugs

Substitui o antigo `SLUG_MAP` hardcoded. Lê todos os event types da API Cal.com, categoriza-os e persiste em `data/calcom-catalog.json`.

**Estrutura do catálogo:**
```json
{
  "consultorio": {
    "lisboa":   { "relaxamento": { "60": { "slug": "...", "price": 50 }, "90": {...} }, ... },
    "cascais":  { ... }
  },
  "domicilio":  { "relaxamento": { "60": { "slug": "...", "price": 65 } }, ... }
}
```

**Função principal:** `resolveSlug(service, duration, isDomicilio, city)` — devolve o slug correcto ou fallback para relaxamento 60min Lisboa.

**Refresh:** automático a cada 24h + manual via `POST /admin/refresh-event-types`.

**Nota:** event types com `hidden: true` (ex: planos mensais) são carregados mas nunca devolvidos por `resolveSlug`.

---

## Preços ao domicílio (`src/core/domicilio.js`)

Base: Rua Jorge Colaço 32A, 1700-253 Lisboa

| Zona | Surcharge |
|---|---|
| ≤5km | +15€ (mínimo de deslocação) |
| ≤10km | +20€ |
| ≤15km | +25€ |
| ≤20km | +30€ |
| ≤25km | +35€ |
| >25km | Não disponível |

Preços base (= preço de consultório, sem deslocação):
- Relaxamento/Terapêutica 60min: 50€ | 90min: 70€
- Express 30min: 35€
- Visceral/Quantum 60min: 50€

**Todos os surcharges confirmados** (tratamentes.pt/localizacoes/ 2026-05-01). Ver detalhes em `~/wiki/serenbot/domicilio.md`.

---

## Endpoints da API

### Públicos (requerem `x-api-token` ou `?token=`)

| Método | Path | Params chave | O que faz |
|---|---|---|---|
| GET | `/health` | — | Health check |
| GET | `/availability` | `date`, `service`, `duration`, `city`, `isDomicilio` | Slots disponíveis Cal.com |
| GET | `/context` | — | Knowledge graph para contexto do agente |
| GET | `/client` | `phone` | Buscar cliente Kommo por telefone |
| GET | `/bookings` | `email` ou `phone` | Reservas futuras do cliente |
| GET | `/bookings-by-date` | `date` | Reservas por data |
| GET | `/distance` | `address` | Distância geocodificada ao prestador |
| GET | `/domicilio-check` | `address`, `service`, `duration` | Verifica elegibilidade + preço ao domicílio |
| GET | `/whatsapp-ping` | `sender`, `name` | Notifica admin quando cliente WhatsApp inicia conversa |
| GET | `/telegram-ping` | `sender`, `name`, `username` | Notifica admin quando cliente Telegram inicia conversa |
| POST | `/booking` | body JSON | Criar reserva Cal.com + registar Kommo |
| POST | `/reschedule` | body JSON | Reagendar reserva Cal.com |
| POST | `/cancel` | body JSON | Cancelar reserva Cal.com |
| POST | `/notify-paulo` | body JSON | Enviar notificação directa ao admin |

### Webhooks

| Método | Path | Autenticação | Origem |
|---|---|---|---|
| POST | `/webhook/caleu` | HMAC `WEBHOOK_SECRET` | Cal.com → notifica admin, move lead Kommo |
| POST | `/telegram/seren` | `X-Telegram-Bot-Api-Secret-Token` | Telegram → Seren Lite state machine |

### Admin (requerem API_TOKEN)

| Método | Path | O que faz |
|---|---|---|
| POST | `/admin/refresh-event-types` | Força reload do catálogo Cal.com da API |
| GET | `/admin/catalog` | Devolve catálogo completo em JSON |
| GET | `/admin/ab-stats` | Estatísticas A/B de respostas |
| POST | `/admin/responses/reload` | Hot-reload de responses.json sem restart |
| POST | `/admin/otp/generate` | Gera OTP e envia ao admin via Telegram |
| POST | `/admin/otp/verify` | Verifica código OTP (TTL 5min, máx 3 tentativas) |

### Aliases GET (para agentes externos via web_fetch)

| GET alias | Equivalente POST |
|---|---|
| `/book` | `/booking` |
| `/book-cancel` | `/cancel` |
| `/book-reschedule` | `/reschedule` |
| `/alert` | `/notify-paulo` |

---

## Configuração — variáveis de ambiente

Ficheiro: `/opt/serenbot/.env` (chmod 600, root:root)

| Variável | Valor / Notas |
|---|---|
| `APP_NAME` | `Tratamentes` |
| `BOT_CLIENT_NAME` | `Seren` — nome do bot nos logs e notificações |
| `API_PORT` | `3002` |
| `TELEGRAM_TOKEN_AGENT1` | `8726268422:...` — suporte_tratamentes_bot (Seren Lite) |
| `TELEGRAM_BOT_B_TOKEN` | bot de notificações admin (notify.js → sendMessage para João) |
| `TELEGRAM_ADMIN_ID` | `6279806258` (João) |
| `TELEGRAM_WEBHOOK_SECRET` | valida `X-Telegram-Bot-Api-Secret-Token` em POST /telegram/seren |
| `KOMMO_SUBDOMAIN` | `joaogoulart` |
| `KOMMO_ACCESS_TOKEN` | JWT — **expira 2027-04-30** — renovar antes |
| `KOMMO_RESPONSIBLE_USER_ID` | `14608143` |
| `KOMMO_PIPELINE_ID` | `12907567` (Funil de Vendas) |
| `KOMMO_PIPELINE_ATIVOS_ID` | `12990767` (Clientes Ativos) |
| `KOMMO_STATUS_AGENDADO` | `99528395` |
| `KOMMO_STATUS_ATIVOS_AGENDADO` | `100167911` |
| `CALCOM_BASE_URL` | `https://api.cal.com/v2` |
| `CALCOM_API_KEY` | `cal_live_...` |
| `CALCOM_USERNAME` | `joao-goulart-tratamentes-lisboa-cascais` |
| `CALCOM_TIMEZONE` | `Europe/Lisbon` |
| `OPENROUTER_API_KEY` | Opcional; OpenRouter/BYOK para classificação auxiliar de intenção |
| `LLM_INTENT_ENABLED` | `false` por defeito; activar só se quiser usar LLM como classificador |
| `LLM_INTENT_MODEL` | `google/gemini-2.5-flash-lite` |
| `LLM_INTENT_MONTHLY_BUDGET_EUR` | orçamento alvo, recomendado `5` |
| `LLM_INTENT_MONTHLY_HARD_LIMIT_EUR` | hard cap operacional, recomendado `15` |
| `API_TOKEN` | protege endpoints SerenBot |
| `WEBHOOK_SECRET` | HMAC para webhooks Cal.com |

**OTP clinica.tratamentes.pt:** `/home/tratame3/config.php` → `TELEGRAM_BOT_TOKEN=8649911217:...` (clinicatmotp_bot, separado)

---

## IDs Kommo hardcoded em `src/infra/kommo.js`

Específicos da conta `joaogoulart.kommo.com` — não mudam salvo apagar/recriar no Kommo.

Para consultar/validar:
```bash
curl -s "https://joaogoulart.kommo.com/api/v4/leads/pipelines" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" | python3 -m json.tool

curl -s "https://joaogoulart.kommo.com/api/v4/contacts/custom_fields" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" | python3 -m json.tool
```

---

## Serviços systemd

| Serviço | Comando | Porta | Notas |
|---|---|---|---|
| `serenbot-api` | `node src/api.js` | 3002 | EnvironmentFile: /opt/serenbot/.env |

```bash
sudo systemctl status serenbot-api
sudo journalctl -u serenbot-api -f
sudo systemctl restart serenbot-api
```

---

## Seren Lite — bot nativo

**Webhook:** `POST /telegram/seren` — protegido por `X-Telegram-Bot-Api-Secret-Token`

**Estados da conversa:**
`NEW → QUALIFYING → QUALIFIED → AWAITING_LOCATION → AWAITING_DURATION → COLLECTING_PHONE → CONFIRMING_CONTACT / COLLECTING_NAME → COLLECTING_EMAIL → SELECTING_DATE → SELECTING_TIME → CONFIRMING_BOOKING → BOOKED`

**Deep links de campanha:** `t.me/suporte_tratamentes_bot?start=terapeutica` → salta qualifying, vai directo para serviço

**Lomi-Lomi / Sueca:** usam slugs de relaxamento + campo `bookingNote` com nome da técnica. Nunca criar slugs separados.

**Cal.com username:** `joao-goulart-tratamentes-lisboa-cascais` (NUNCA cal.eu — abandonado por bugs)

---

## Estado das integrações (2026-05-03)

| Integração | Estado | Notas |
|---|---|---|
| Kommo CRM | ✅ Token válido, IDs confirmados | Expira 2027-04-30 |
| Cal.com | ✅ API key e username configurados | Catálogo: 30 event types carregados |
| Seren (suporte_tratamentes_bot) | ✅ Webhook nativo | src/bot/seren-handler.js |
| Bot notificações admin | ✅ Activo | notify.js → TELEGRAM_BOT_B_TOKEN → João |
| clinicatmotp_bot | ✅ Activo | OTP login clinica.tratamentes.pt |
| Geocoding | ✅ Nominatim | Cache SQLite em data/geocache.db |
| OpenRouter | ⚙️ Opcional, Gemini Flash Lite como classificador JSON | intent-analyzer.js |
| Cloudflare Tunnel (api.tratamentes.pt) | ✅ Activo | localhost:3002 |

---

## Notas de manutenção

- **Token Kommo expira**: 2027-04-30 — renovar em Kommo → Integrações antes dessa data
- **Geocache**: TTL 90 dias, limpa automaticamente no arranque
- **Catálogo Cal.com**: `data/calcom-catalog.json` — actualizar via `POST /admin/refresh-event-types`
- **Logs SerenBot**: `sudo journalctl -u serenbot-api --since today`
- **Express trust proxy**: `app.set('trust proxy', 1)` já configurado — necessário para rate-limiter atrás do Cloudflare
