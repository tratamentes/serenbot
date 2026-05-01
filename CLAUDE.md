# SerenBot — Manual para IA

> Documento vivo. Actualizar após cada sessão de trabalho que mude a arquitectura.
> Última revisão: 2026-05-01

---

## O que é isto

SerenBot é uma API Node.js que serve de ponte entre o agente OpenClaw (IA de conversação) e os serviços externos: **Cal.com** (agendamentos), **Kommo CRM** (gestão de clientes e leads) e **Telegram** (notificações ao admin).

Não é um bot autónomo — é o backend que o agente invoca via HTTP quando precisa de agendar, consultar disponibilidade, registar um cliente, ou notificar o prestador.

---

## Arquitectura

```
Telegram (clientes)                    Telegram (João — admin)
        │                                       │
        ▼                                       ▼
  OpenClaw Gateway — Seren             OpenClaw Gateway — Nexus
  localhost:18789                       localhost:18790
  suporte_tratamentes_bot               clinicatm_bot
  ~/.openclaw/workspace/                ~/.openclaw-admin/.openclaw/workspace/
        │
        ▼
  SerenBot API (localhost:3002)   ←── EnvironmentFile: /opt/serenbot/.env
     │         │         │
     ▼         ▼         ▼
  Cal.com   Kommo CRM  clinicatm_bot
  (agenda)  (leads)    (notificações admin via notify.js)

Telegram (João — OTP login clinica)
        ↑
  clinicatmotp_bot  ←── /home/tratame3/config.php
```

**Três bots Telegram:**
- `suporte_tratamentes_bot` (`8726268422:...`) — **Seren**, bot dos clientes, OpenClaw agente `main`, porta 18789
- `clinicatm_bot` (`8529403509:...`) — **Nexus**, agente admin OpenClaw (porta 18790) + notificações SerenBot ao João
- `clinicatmotp_bot` (`8649911177:...`) — apenas envia códigos OTP para login em clinica.tratamentes.pt

**clinicatm_bot serve dois propósitos sem conflito:**
1. OpenClaw (porta 18790) lê mensagens de João e responde como Nexus
2. SerenBot (`notify.js`) envia notificações ao João via sendMessage
Não há conflito — ambos só usam sendMessage em saída; o OpenClaw lê os updates de entrada.

**Zero portas expostas** — tudo chega via Cloudflare Tunnel:
- `bots.tratamentes.pt` → localhost:18789 (OpenClaw Gateway Seren)
- `api.tratamentes.pt`  → localhost:3002  (SerenBot API)
- Gateway Nexus (18790) — interno, só João via Telegram

---

## Ficheiros principais

| Ficheiro | Responsabilidade |
|---|---|
| `src/api.js` | Express app, todos os endpoints, ponto de entrada |
| `src/infra/calcom.js` | Cal.com v2 API — slots, reservas, cancelamentos |
| `src/infra/calcom-catalog.js` | Catálogo dinâmico de slugs Cal.com (lê da API, persiste em disco, serve lookups síncronos) |
| `src/infra/kommo.js` | Kommo CRM — contacts, leads, pipeline moves |
| `src/infra/notify.js` | Notificações Telegram para o admin (clinicatm_bot) |
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
| `src/utils/graph-context.js` | Carrega knowledge graph para contexto do agente |
| `src/openrouter-proxy.js` | Proxy para OpenRouter (bypass Presidio PII redaction) |
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

**Surcharges >5km são estimativas** — confirmar com Paulo.

---

## Endpoints da API

### Públicos (requerem `Authorization: Bearer $API_TOKEN`)

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

### Webhooks (requerem `X-Cal-Signature-256` HMAC — `$WEBHOOK_SECRET`)

| Método | Path | Origem |
|---|---|---|
| POST | `/webhook/caleu` | Cal.com → notifica admin, move lead Kommo |

### Admin (requerem API_TOKEN)

| Método | Path | O que faz |
|---|---|---|
| POST | `/admin/refresh-event-types` | Força reload do catálogo Cal.com da API |
| GET | `/admin/catalog` | Devolve catálogo completo em JSON |
| GET | `/admin/sessions` | Lista sessões OpenClaw do agente `main` (HTML) |

---

## Configuração — variáveis de ambiente

Ficheiro: `/opt/serenbot/.env` (chmod 600, root:root)

| Variável | Valor / Notas |
|---|---|
| `APP_NAME` | `Tratamentes` |
| `BOT_CLIENT_NAME` | `Seren` — nome do bot nos logs e notificações |
| `KOMMO_SUBDOMAIN` | `joaogoulart` |
| `KOMMO_ACCESS_TOKEN` | JWT — **expira 2026-06-29** — renovar antes |
| `KOMMO_RESPONSIBLE_USER_ID` | `14608143` |
| `KOMMO_PIPELINE_ID` | `12907567` (Funil de Vendas) |
| `KOMMO_PIPELINE_ATIVOS_ID` | `12990767` (Clientes Ativos) |
| `KOMMO_STATUS_AGENDADO` | `99528395` |
| `KOMMO_STATUS_ATIVOS_AGENDADO` | `100167911` |
| `CALCOM_BASE_URL` | `https://api.cal.com/v2` |
| `CALCOM_API_KEY` | `cal_live_...` |
| `CALCOM_USERNAME` | `joao-goulart-tratamentes-lisboa-cascais` |
| `CALCOM_TIMEZONE` | `Europe/Lisbon` |
| `TELEGRAM_BOT_B_TOKEN` | `8529403509:...` — clinicatm_bot (notificações admin) |
| `TELEGRAM_ADMIN_ID` | `6279806258` (João) |
| `TELEGRAM_TOKEN_AGENT1` | `8726268422:...` — suporte_tratamentes_bot (Seren) |
| `API_TOKEN` | protege endpoints SerenBot |
| `WEBHOOK_SECRET` | HMAC para webhooks Cal.com |
| `OPENCLAW_AGENT_NAME` | `main` (agente OpenClaw = suporte_tratamentes_bot) |

**OTP clinica.tratamentes.pt:** `/home/tratame3/config.php` → `TELEGRAM_BOT_TOKEN=8649911177:...` (clinicatmotp_bot, separado)

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

| Serviço | Comando | Porto | Notas |
|---|---|---|---|
| `serenbot-api` | `node src/api.js` | 3002 | EnvironmentFile: /opt/serenbot/.env |
| `openclaw-gateway` | openclaw gateway | 18789 | Seren — bot clientes |
| `openclaw-admin-gateway` | openclaw gateway (HOME=~/.openclaw-admin) | 18790 | Nexus — bot admin João |
| `serenbot-proxy` | `node src/openrouter-proxy.js` | — | não instalado |

```bash
# Seren (clientes)
systemctl --user status openclaw-gateway.service
journalctl --user -u openclaw-gateway.service -f

# Nexus (admin)
systemctl --user status openclaw-admin-gateway.service
journalctl --user -u openclaw-admin-gateway.service -f

# SerenBot API
sudo systemctl status serenbot-api
sudo journalctl -u serenbot-api -f
```

---

## Estado das integrações (2026-05-01)

| Integração | Estado | Notas |
|---|---|---|
| Kommo CRM | ✅ Token válido, IDs confirmados | Expira 2026-06-29 |
| Cal.com | ✅ API key e username configurados | Catálogo: 30 event types carregados |
| Seren (suporte_tratamentes_bot) | ✅ Activo, porta 18789 | Agente `main`, allowFrom: só João por agora |
| Nexus (clinicatm_bot) | ✅ Activo, porta 18790 | Agente admin, só João (6279806258) |
| clinicatmotp_bot | ✅ Activo | OTP login clinica.tratamentes.pt |
| Geocoding | ✅ Nominatim | Cache SQLite em data/geocache.db |
| OpenRouter | ✅ Claude Sonnet 4.6 | Ambos os gateways usam openrouter:default |
| Cloudflare Tunnel (api.tratamentes.pt) | ⚠️ Por configurar | localhost:3002 |

---

## Notas de manutenção

- **Token Kommo expira**: 2026-06-29 — renovar em Kommo → Integrações antes dessa data
- **Geocache**: TTL 90 dias, limpa automaticamente no arranque
- **Sessions Seren**: `~/.openclaw/agents/main/sessions/`
- **Sessions Nexus**: `~/.openclaw-admin/.openclaw/agents/admin/sessions/`
- **Workspace Nexus**: `~/.openclaw-admin/.openclaw/workspace/` — treinar o Nexus aqui
- **Catálogo Cal.com**: `data/calcom-catalog.json` — actualizar via `POST /admin/refresh-event-types`
- **Logs SerenBot**: `sudo journalctl -u serenbot-api --since today`
- **Abrir Seren a todos os clientes**: editar `~/.openclaw/credentials/telegram-default-allowFrom.json`
- **Express trust proxy**: `app.set('trust proxy', 1)` já configurado — necessário para rate-limiter atrás do Cloudflare
