# SerenBot — Diário de Trabalho e Testes

> Ficheiro vivo. Cada sessão de testes acrescenta uma secção com data, resultado e acção tomada.
> Quando uma integração estiver estável, o resultado vai para INSTALL.md e o entry fica aqui como referência histórica.

---

## 2026-04-29 — Sessão de arranque: migração .env + serviços

### Contexto
Primeira vez que o SerenBot Node.js corre neste servidor como serviço systemd.
O servidor já tinha: tratamentes-api Python (porta 3001), OpenClaw Gateway (18789), Nginx (8080), Cloudflare Tunnel.

### O que foi feito
1. `npm install --production` em `/home/joao/serenbot` — 107 pacotes, 0 vulnerabilidades
2. `.env` migrado de variáveis antigas para nomes novos, IDs Kommo preenchidos via API
3. `src/api.js` corrigido: porta hardcoded 3001 → `process.env.API_PORT || 3001`
4. Serviço `serenbot-api.service` criado em `/etc/systemd/system/`, enabled + started
5. `CLAUDE.md` criado no root do repo

### Conflito de porta resolvido
- Porta 3001 já ocupada por `tratamentes-api` Python (processo 898, PID fixo desde arranque)
- Cloudflare Tunnel actual aponta tudo para Nginx:8080 — sem rota directa a 3001 ou 3002
- Decisão: SerenBot corre em **porta 3002** até migração completa da tratamentes-api

### Resultados dos testes

| Integração | Teste | Resultado | Notas |
|---|---|---|---|
| API local | `GET /health` | ✅ `{"status":"ok"}` | Serviço a correr |
| Kommo CRM | `GET /client?phone=351912345678` | ✅ `{"found":false}` | Token válido, subdomain correcto |
| Telegram Bot B | `GET https://api.telegram.org/bot.../getMe` | ✅ `suporte_tratamentes_bot` | Token válido |
| Cal.eu | `GET /availability` | ⚠️ não testado | CALCOM_API_KEY está vazio |
| OpenRouter Proxy | — | ⚠️ não instalado | OPENROUTER_API_KEY está vazio |
| Webhook Cal.eu | — | ⚠️ não testado | Precisa de tunnel configurado para porta 3002 |

### O que falta

| Item | Prioridade | O que é preciso |
|---|---|---|
| `TELEGRAM_ADMIN_ID` | Alta | João enviar mensagem ao `suporte_tratamentes_bot` e correr `getUpdates` |
| `CALCOM_API_KEY` | Alta | app.cal.eu → Settings → API Keys → criar token |
| `CALCOM_USERNAME` | Alta | Slug do calendário (ex: `paulo-massagem`) |
| Tunnel → porto 3002 | Média | Adicionar entrada no `~/.cloudflared/config.yml` para `api.tratamentes.pt → 3002` |
| `OPENROUTER_API_KEY` | Baixa | openrouter.ai → Keys (só necessário se usar bypass Presidio) |

### Como obter TELEGRAM_ADMIN_ID
1. Ir ao Telegram e enviar qualquer mensagem ao bot `@suporte_tratamentes_bot`
2. Correr: `curl "https://api.telegram.org/bot8726268422:AAEEQ7ApKTbsa9RY9X4U9WbtISjVTk58eY8/getUpdates"`
3. Procurar `"from": {"id": XXXXXXX}` — esse é o ADMIN_ID
4. Editar `/opt/serenbot/.env`: `TELEGRAM_ADMIN_ID=XXXXXXX`
5. `sudo systemctl restart serenbot-api`

---

## Template para sessões futuras

```
## YYYY-MM-DD — Descrição breve

### Contexto
[O que estava a tentar fazer]

### Resultados
| Integração | Teste | Resultado | Notas |
|---|---|---|---|

### Erros encontrados
[Stack traces, mensagens de erro]

### Acções tomadas
[O que foi mudado]

### Próximos passos
[O que ficou por fazer]
```
