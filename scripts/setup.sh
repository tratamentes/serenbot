#!/usr/bin/env bash
# =============================================================================
# SerenBot — Setup Wizard
# =============================================================================
# Uso: bash scripts/setup.sh
# Testado em: Ubuntu 22.04, Debian 12
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${BLUE}▸${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
die()  { err "$*"; exit 1; }
sep()  { echo -e "\n${CYAN}══════════════════════════════════════${NC}"; }

# Estado de progresso — permite retomar se interrompido
STATE_FILE="/tmp/.serenbot_setup_state"
declare -A STATE=()

state_save() { echo "$1=$2" >> "$STATE_FILE"; }
state_load() {
  [[ -f "$STATE_FILE" ]] || return
  while IFS='=' read -r k v; do STATE["$k"]="$v"; done < "$STATE_FILE"
}
state_get() { echo "${STATE[$1]:-}"; }
state_done() { [[ "$(state_get "$1")" == "done" ]]; }
state_load

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# =============================================================================
# BANNER
# =============================================================================
clear
echo -e "${BOLD}${CYAN}"
cat << 'BANNER'
  ╔══════════════════════════════════════════╗
  ║           SerenBot — Setup              ║
  ║   Bot de agendamento autónomo · Node    ║
  ╚══════════════════════════════════════════╝
BANNER
echo -e "${NC}"

if [[ $EUID -ne 0 ]]; then
  sudo -n true 2>/dev/null || die "Precisas de sudo sem password ou correr como root."
  SUDO="sudo"
else
  SUDO=""
fi

# =============================================================================
# PREFLIGHT
# =============================================================================
sep
echo -e "${BOLD}PREFLIGHT${NC}"

command -v curl >/dev/null 2>&1 || die "curl não encontrado. Instala: apt install curl"
ok "curl disponível"

MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
[[ $MEM_MB -lt 400 ]] && warn "RAM: ${MEM_MB}MB (recomendado: 512MB+)" || ok "RAM: ${MEM_MB}MB"

# =============================================================================
# NODE.JS
# =============================================================================
sep
echo -e "${BOLD}NODE.JS (>= 18)${NC}"

install_nodejs() {
  info "A instalar Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
  ok "Node.js instalado: $(node --version)"
  state_save "nodejs_installed" "done"
}

if state_done "nodejs_installed"; then
  ok "Node.js já instalado"
elif command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node --version | tr -d 'v' | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    ok "Node.js: $(node --version)"
    state_save "nodejs_installed" "done"
  else
    warn "Node.js $(node --version) — mínimo é 18. A actualizar..."
    install_nodejs
  fi
else
  install_nodejs
fi
NODE_BIN=$(command -v node)

# =============================================================================
# DEPENDÊNCIAS NPM
# =============================================================================
sep
echo -e "${BOLD}DEPENDÊNCIAS NPM${NC}"

if state_done "npm_installed"; then
  ok "Dependências já instaladas"
else
  [[ -f "$REPO_DIR/package.json" ]] || die "package.json não encontrado em $REPO_DIR"
  info "A instalar dependências..."
  (cd "$REPO_DIR" && npm install --production)
  ok "npm install concluído"
  state_save "npm_installed" "done"
fi

# =============================================================================
# CREDENCIAIS
# =============================================================================
sep
echo -e "${BOLD}CREDENCIAIS${NC}"
echo -e "  Preenche agora ou salta com Enter (podes editar /opt/serenbot/.env depois)."

ask_token() {
  local var="$1" label="$2" hint="$3" current val
  current=$(state_get "$var")
  if [[ -n "$current" ]]; then
    ok "$label já configurado"
    printf -v "$var" '%s' "$current"; return
  fi
  echo -e "\n  ${BOLD}$label${NC}"
  [[ -n "$hint" ]] && echo -e "    ${YELLOW}Onde obter:${NC} $hint"
  read -r -s -p "    Valor (oculto): " val; echo ""
  if [[ -n "$val" ]]; then
    state_save "$var" "$val"
    printf -v "$var" '%s' "$val"
    ok "Guardado"
  else
    warn "Saltado — edita /opt/serenbot/.env depois"
    printf -v "$var" '%s' ""
  fi
}

ask_text() {
  local var="$1" label="$2" hint="$3" current val
  current=$(state_get "$var")
  if [[ -n "$current" ]]; then
    ok "$label: $current"
    printf -v "$var" '%s' "$current"; return
  fi
  echo -e "\n  ${BOLD}$label${NC}"
  [[ -n "$hint" ]] && echo -e "    ${YELLOW}Info:${NC} $hint"
  read -r -p "    Valor: " val
  if [[ -n "$val" ]]; then
    state_save "$var" "$val"
    printf -v "$var" '%s' "$val"
    ok "Guardado"
  else
    warn "Saltado"
    printf -v "$var" '%s' ""
  fi
}

sep; echo -e "${BOLD}TELEGRAM${NC}"
ask_token "TELEGRAM_TOKEN_AGENT1" \
  "Bot Token — Seren (bot de clientes)" \
  "@BotFather → /newbot"
ask_token "TELEGRAM_BOT_B_TOKEN" \
  "Bot Token — notificações admin (bot separado)" \
  "@BotFather → /newbot  (pode ser o mesmo bot se quiseres)"
ask_text "TELEGRAM_ADMIN_ID" \
  "O teu Telegram Chat ID" \
  "Envia qualquer mensagem a @userinfobot para saber o teu ID"

sep; echo -e "${BOLD}CAL.COM${NC}"
ask_token "CALCOM_API_KEY" \
  "Cal.com API Key" \
  "cal.com → Settings → API Keys"
ask_text "CALCOM_USERNAME" \
  "Cal.com username (slug do calendário)" \
  "Aparece no URL das tuas reservas: cal.com/{username}"

sep; echo -e "${BOLD}KOMMO CRM${NC}"
ask_text "KOMMO_SUBDOMAIN" \
  "Kommo subdomain" \
  "Se acedes em empresa.kommo.com, o subdomain é 'empresa'"
ask_token "KOMMO_ACCESS_TOKEN" \
  "Kommo Access Token (long-lived)" \
  "Kommo → Configurações → Integrações → API"
ask_text "KOMMO_RESPONSIBLE_USER_ID" "Kommo Responsible User ID" ""
echo ""
warn "IDs de pipeline/status precisam de configuração manual em /opt/serenbot/.env"
warn "Obtém via: curl 'https://{subdomain}.kommo.com/api/v4/leads/pipelines' -H 'Authorization: Bearer TOKEN'"

sep; echo -e "${BOLD}OPENROUTER (LLM fallback)${NC}"
ask_token "OPENROUTER_API_KEY" \
  "OpenRouter API Key" \
  "openrouter.ai → Keys"

sep; echo -e "${BOLD}CLOUDFLARE${NC}"
ask_text "CF_DOMAIN" \
  "Domínio base (ex: empresa.com)" \
  "Domínio que tens no Cloudflare — o tunnel vai criar api.{dominio}"

# Gerar tokens de segurança automaticamente
API_TOKEN=$(state_get "API_TOKEN")
if [[ -z "$API_TOKEN" ]]; then
  API_TOKEN=$(openssl rand -hex 32)
  state_save "API_TOKEN" "$API_TOKEN"
  ok "API_TOKEN gerado automaticamente"
fi

WEBHOOK_SECRET=$(state_get "WEBHOOK_SECRET")
if [[ -z "$WEBHOOK_SECRET" ]]; then
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  state_save "WEBHOOK_SECRET" "$WEBHOOK_SECRET"
  ok "WEBHOOK_SECRET gerado automaticamente"
fi

TELEGRAM_WEBHOOK_SECRET=$(state_get "TELEGRAM_WEBHOOK_SECRET")
if [[ -z "$TELEGRAM_WEBHOOK_SECRET" ]]; then
  TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
  state_save "TELEGRAM_WEBHOOK_SECRET" "$TELEGRAM_WEBHOOK_SECRET"
  ok "TELEGRAM_WEBHOOK_SECRET gerado automaticamente"
fi

# =============================================================================
# CRIAR .ENV
# =============================================================================
sep
echo -e "${BOLD}A criar /opt/serenbot/.env${NC}"

ENV_DIR="/opt/serenbot"
ENV_FILE="$ENV_DIR/.env"
$SUDO mkdir -p "$ENV_DIR"

$SUDO tee "$ENV_FILE" > /dev/null << EOF
# SerenBot — gerado por setup.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ)
# chmod 600. NÃO commitar.

APP_NAME=SerenBot
BOT_CLIENT_NAME=Seren
API_PORT=3002

# Telegram — Seren (bot de clientes)
TELEGRAM_TOKEN_AGENT1=${TELEGRAM_TOKEN_AGENT1:-CONFIGURAR}

# Telegram — notificações admin
TELEGRAM_BOT_B_TOKEN=${TELEGRAM_BOT_B_TOKEN:-CONFIGURAR}
TELEGRAM_ADMIN_ID=${TELEGRAM_ADMIN_ID:-CONFIGURAR}
TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}

# Cal.com
CALCOM_BASE_URL=https://api.cal.com/v2
CALCOM_API_KEY=${CALCOM_API_KEY:-CONFIGURAR}
CALCOM_USERNAME=${CALCOM_USERNAME:-CONFIGURAR}
CALCOM_TIMEZONE=Europe/Lisbon

# Kommo CRM
KOMMO_SUBDOMAIN=${KOMMO_SUBDOMAIN:-CONFIGURAR}
KOMMO_ACCESS_TOKEN=${KOMMO_ACCESS_TOKEN:-CONFIGURAR}
KOMMO_RESPONSIBLE_USER_ID=${KOMMO_RESPONSIBLE_USER_ID:-CONFIGURAR}
KOMMO_PIPELINE_ID=CONFIGURAR
KOMMO_PIPELINE_ATIVOS_ID=CONFIGURAR
KOMMO_STATUS_AGENDADO=CONFIGURAR
KOMMO_STATUS_ATIVOS_AGENDADO=CONFIGURAR

# OpenRouter (LLM fallback Seren)
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-CONFIGURAR}

# Segurança API
API_TOKEN=${API_TOKEN}
WEBHOOK_SECRET=${WEBHOOK_SECRET}
EOF

$SUDO chmod 600 "$ENV_FILE"
$SUDO chown root:root "$ENV_FILE"
ok ".env criado em $ENV_FILE (chmod 600)"

MISSING=$(grep -c "=CONFIGURAR" "$ENV_FILE" 2>/dev/null || true)
[[ $MISSING -gt 0 ]] && warn "$MISSING campos por preencher em $ENV_FILE"

# =============================================================================
# CLOUDFLARED
# =============================================================================
sep
echo -e "${BOLD}CLOUDFLARED${NC}"

if state_done "cloudflared_installed" || command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared já instalado"
  state_save "cloudflared_installed" "done"
else
  ARCH=$(uname -m)
  case $ARCH in
    x86_64)  CF_ARCH="amd64" ;;
    aarch64) CF_ARCH="arm64" ;;
    *) die "Arquitectura não suportada: $ARCH" ;;
  esac
  info "A instalar cloudflared (${CF_ARCH})..."
  TMP_DEB=$(mktemp /tmp/cloudflared-XXXXXX.deb)
  curl -L --output "$TMP_DEB" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}.deb"
  $SUDO dpkg -i "$TMP_DEB"
  rm -f "$TMP_DEB"
  ok "cloudflared instalado"
  state_save "cloudflared_installed" "done"
fi

if [[ -n "${CF_DOMAIN:-}" ]] && ! state_done "cf_tunnel_created"; then
  echo ""
  warn "Passo seguinte: autenticação Cloudflare (abre URL no browser)"
  read -r -p "  Prima Enter para continuar..."
  cloudflared tunnel login

  TUNNEL_NAME="serenbot"
  TUNNEL_OUTPUT=$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1 || true)
  if echo "$TUNNEL_OUTPUT" | grep -q "already exists"; then
    warn "Tunnel já existe — a reutilizar"
    TUNNEL_UUID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}' | head -1)
  else
    TUNNEL_UUID=$(echo "$TUNNEL_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  fi
  [[ -z "$TUNNEL_UUID" ]] && die "Não foi possível obter UUID do tunnel"
  ok "Tunnel UUID: $TUNNEL_UUID"

  $SUDO mkdir -p /etc/cloudflared
  $SUDO tee /etc/cloudflared/config.yml > /dev/null << CFEOF
tunnel: ${TUNNEL_UUID}
credentials-file: ${HOME}/.cloudflared/${TUNNEL_UUID}.json

ingress:
  - hostname: api.${CF_DOMAIN}
    service: http://localhost:3002
  - service: http_status:404
CFEOF
  ok "Tunnel config criada"

  cloudflared tunnel route dns "$TUNNEL_NAME" "api.${CF_DOMAIN}" 2>/dev/null \
    && ok "DNS: api.${CF_DOMAIN}" \
    || warn "DNS: falhou (pode já existir)"

  $SUDO cloudflared service install && ok "cloudflared.service instalado" || warn "cloudflared service install falhou"
  $SUDO systemctl start cloudflared 2>/dev/null || true
  state_save "cf_tunnel_created" "done"
  state_save "cf_tunnel_uuid" "$TUNNEL_UUID"
fi

# =============================================================================
# SERVIÇO SYSTEMD
# =============================================================================
sep
echo -e "${BOLD}SERVIÇO SYSTEMD — serenbot-api${NC}"

SCRIPT_USER="${SUDO_USER:-$(whoami)}"

$SUDO tee /etc/systemd/system/serenbot-api.service > /dev/null << EOF
[Unit]
Description=SerenBot API
After=network.target

[Service]
Type=simple
User=${SCRIPT_USER}
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} src/api.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable serenbot-api
$SUDO systemctl restart serenbot-api
sleep 2
$SUDO systemctl is-active --quiet serenbot-api \
  && ok "serenbot-api: running" \
  || warn "serenbot-api: pode não ter iniciado — verifica: journalctl -u serenbot-api -n 30"

# =============================================================================
# REGISTAR WEBHOOK TELEGRAM
# =============================================================================
sep
echo -e "${BOLD}WEBHOOK TELEGRAM${NC}"

if [[ -n "${TELEGRAM_TOKEN_AGENT1:-}" && -n "${CF_DOMAIN:-}" ]]; then
  WEBHOOK_URL="https://api.${CF_DOMAIN}/telegram/seren"
  RESULT=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN_AGENT1}/setWebhook" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"${WEBHOOK_URL}\", \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"}")
  echo "$RESULT" | grep -q '"ok":true' \
    && ok "Webhook registado: $WEBHOOK_URL" \
    || warn "Webhook: falhou — $RESULT"
else
  warn "Telegram token ou CF_DOMAIN em falta — regista o webhook manualmente:"
  echo "  curl -X POST 'https://api.telegram.org/bot<TOKEN>/setWebhook' \\"
  echo "    -d '{\"url\": \"https://api.<DOMINIO>/telegram/seren\", \"secret_token\": \"<TELEGRAM_WEBHOOK_SECRET>\"}'"
fi

# =============================================================================
# VERIFICAÇÃO FINAL
# =============================================================================
sep
echo -e "${BOLD}VERIFICAÇÃO${NC}"

curl -sf --max-time 5 "http://localhost:3002/health" >/dev/null \
  && ok "API local: OK" \
  || warn "API local: não responde (pode estar a arrancar)"

[[ -n "${CF_DOMAIN:-}" ]] && \
  curl -sf --max-time 10 "https://api.${CF_DOMAIN}/health" >/dev/null \
    && ok "Tunnel: OK" \
    || warn "Tunnel: não responde ainda (pode demorar 1-2 min)"

STILL_MISSING=$(grep "=CONFIGURAR" "$ENV_FILE" 2>/dev/null | grep -v "^#" | cut -d= -f1 || true)
if [[ -n "$STILL_MISSING" ]]; then
  echo ""
  warn "Campos por preencher em $ENV_FILE:"
  echo "$STILL_MISSING" | while read -r f; do echo "    - $f"; done
fi

# =============================================================================
# SUMÁRIO
# =============================================================================
sep
echo -e "${BOLD}${GREEN}INSTALAÇÃO CONCLUÍDA${NC}"
sep

echo ""
echo -e "  ${BOLD}Config${NC}         $ENV_FILE"
echo -e "  ${BOLD}Código${NC}         $REPO_DIR"
[[ -n "${CF_DOMAIN:-}" ]] && echo -e "  ${BOLD}API pública${NC}    https://api.${CF_DOMAIN}"
echo ""
echo -e "  ${BOLD}Comandos úteis:${NC}"
echo "    sudo systemctl status serenbot-api"
echo "    sudo journalctl -u serenbot-api -f"
echo ""
echo -e "  ${BOLD}Próximos passos:${NC}"
echo "    1. Preencher os CONFIGURAR em $ENV_FILE"
echo "    2. Configurar webhook Cal.com → https://api.${CF_DOMAIN:-SEU_DOMINIO}/webhook/caleu"
echo "    3. sudo systemctl restart serenbot-api"
echo ""
echo -e "  ${BOLD}API_TOKEN${NC} (para chamadas admin à API):"
echo "    ${API_TOKEN}"
echo ""
echo -e "  ${BOLD}WEBHOOK_SECRET${NC} (configurar no Cal.com → Webhooks):"
echo "    ${WEBHOOK_SECRET}"
echo ""

rm -f "$STATE_FILE"
ok "Estado temporário limpo."
echo ""
