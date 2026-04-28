#!/usr/bin/env bash
# =============================================================================
# SerenBot — Setup Wizard
# =============================================================================
# Uso: bash scripts/setup.sh [--only agent1|agent2|all]
# Testado em: Ubuntu 22.04, Debian 12
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

# --- Cores ---
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${BLUE}▸${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
die()  { err "$*"; exit 1; }
sep()  { echo -e "\n${CYAN}══════════════════════════════════════${NC}"; }

# --- Argumentos ---
INSTALL_MODE="all"
while [[ $# -gt 0 ]]; do
  case $1 in
    --only) INSTALL_MODE="$2"; shift 2 ;;
    *) die "Argumento desconhecido: $1" ;;
  esac
done

# =============================================================================
# ESTADO DE PROGRESSO — permite retomar se o script for interrompido
# =============================================================================
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

# Directório raiz do repositório (onde está o src/)
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# =============================================================================
# BANNER
# =============================================================================
clear
echo -e "${BOLD}${CYAN}"
cat << 'BANNER'
  ╔══════════════════════════════════════════╗
  ║        SerenBot — Setup Wizard          ║
  ║  OpenClaw · Cloudflare Tunnels · Bots   ║
  ╚══════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# =============================================================================
# IDENTIFICAÇÃO DO PROJECTO
# =============================================================================
sep
echo -e "${BOLD}PROJECTO — Como se chama esta instalação?${NC}"
echo ""

PROJECT_NAME=$(state_get "PROJECT_NAME")
if [[ -n "$PROJECT_NAME" ]]; then
  ok "Projecto: $PROJECT_NAME (de sessão anterior)"
else
  echo -e "  Exemplos: ${YELLOW}clinic${NC}, ${YELLOW}salon${NC}, ${YELLOW}myapp${NC}"
  echo -e "  Usado em: pasta de configuração, nome do tunnel, nomes de serviços systemd"
  echo ""
  read -r -p "  Nome do projecto (só letras, números, hífens): " PROJECT_NAME
  PROJECT_NAME=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd '[:alnum:]-')
  [[ -z "$PROJECT_NAME" ]] && die "Nome do projecto é obrigatório."
  state_save "PROJECT_NAME" "$PROJECT_NAME"
fi

ok "Projecto: $PROJECT_NAME"
echo -e "  Modo: ${BOLD}$INSTALL_MODE${NC}"

# Paths derivados do nome do projecto
ENV_DIR="/opt/${PROJECT_NAME}"
ENV_FILE="${ENV_DIR}/.env"
TUNNEL_NAME="${PROJECT_NAME}"
SVC_GATEWAY="${PROJECT_NAME}-gateway"
SVC_API="${PROJECT_NAME}-api"
SVC_PROXY="${PROJECT_NAME}-proxy"

# =============================================================================
# IDENTIDADE DA APLICAÇÃO
# =============================================================================
sep
echo -e "${BOLD}IDENTIDADE — Nome da aplicação e do agente${NC}"
echo ""

APP_NAME=$(state_get "APP_NAME")
if [[ -n "$APP_NAME" ]]; then
  ok "App name: $APP_NAME (de sessão anterior)"
else
  read -r -p "  Nome da aplicação (ex: Salon Nina, Bliss Touch): " APP_NAME
  [[ -z "$APP_NAME" ]] && APP_NAME="SerenBot"
  state_save "APP_NAME" "$APP_NAME"
fi

BOT_CLIENT_NAME=$(state_get "BOT_CLIENT_NAME")
if [[ -n "$BOT_CLIENT_NAME" ]]; then
  ok "Nome do bot cliente: $BOT_CLIENT_NAME (de sessão anterior)"
else
  read -r -p "  Nome do bot cliente (ex: Noa, Sara, Bot): " BOT_CLIENT_NAME
  [[ -z "$BOT_CLIENT_NAME" ]] && BOT_CLIENT_NAME="Bot"
  state_save "BOT_CLIENT_NAME" "$BOT_CLIENT_NAME"
fi

SITE_URL=$(state_get "SITE_URL")
if [[ -n "$SITE_URL" ]]; then
  ok "URL do site: $SITE_URL (de sessão anterior)"
else
  read -r -p "  URL público do site (ex: https://minhaempresa.pt): " SITE_URL
  [[ -z "$SITE_URL" ]] && SITE_URL="https://localhost"
  state_save "SITE_URL" "$SITE_URL"
fi

# =============================================================================
# PREFLIGHT
# =============================================================================
sep
echo -e "${BOLD}PREFLIGHT — A verificar o ambiente${NC}"
sep

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  ok "Sistema: $PRETTY_NAME"
else
  warn "Não foi possível identificar o sistema operativo."
fi

if [[ $EUID -ne 0 ]]; then
  if ! sudo -n true 2>/dev/null; then
    die "Precisas de correr como root ou ter sudo sem password."
  fi
  SUDO="sudo"
  ok "Sudo disponível"
else
  SUDO=""
  ok "A correr como root"
fi

command -v curl >/dev/null 2>&1 || die "curl não encontrado. Instala: apt install curl"
ok "curl disponível"

MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
[[ $MEM_MB -lt 900 ]] && warn "RAM: ${MEM_MB}MB (mínimo recomendado: 1024MB)" || ok "RAM: ${MEM_MB}MB"

DISK_FREE=$(df -BG / | awk 'NR==2{print $4}' | tr -d 'G')
[[ $DISK_FREE -lt 5 ]] && warn "Disco livre: ${DISK_FREE}GB (mínimo: 5GB)" || ok "Disco livre: ${DISK_FREE}GB"

# =============================================================================
# CONFIGURAÇÃO DOS AGENTES
# =============================================================================
sep
echo -e "${BOLD}AGENTES — Quantos bots e com que nomes?${NC}"
echo ""
echo -e "  Cada agente é um bot independente (ex: um para clientes, outro para admin)."
echo -e "  Nome do agente = identificador interno do OpenClaw (ex: ${YELLOW}noa${NC}, ${YELLOW}flux${NC}, ${YELLOW}support${NC})"
echo ""

AGENT1_NAME=$(state_get "AGENT1_NAME")
AGENT2_NAME=$(state_get "AGENT2_NAME")

if [[ -n "$AGENT1_NAME" ]]; then
  ok "Agente 1: $AGENT1_NAME (de sessão anterior)"
else
  read -r -p "  Nome do agente 1 (ex: noa): " AGENT1_NAME
  AGENT1_NAME=$(echo "$AGENT1_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]-')
  [[ -z "$AGENT1_NAME" ]] && AGENT1_NAME="agent1"
  state_save "AGENT1_NAME" "$AGENT1_NAME"
fi

if [[ "$INSTALL_MODE" == "all" ]]; then
  if [[ -n "$AGENT2_NAME" ]]; then
    ok "Agente 2: $AGENT2_NAME (de sessão anterior)"
  else
    read -r -p "  Nome do agente 2 (deixa em branco para instalar só 1): " AGENT2_NAME
    AGENT2_NAME=$(echo "$AGENT2_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]-')
    [[ -n "$AGENT2_NAME" ]] && state_save "AGENT2_NAME" "$AGENT2_NAME" || AGENT2_NAME=""
  fi
fi

configure_sandbox() {
  local agent="$1"
  local key="sandbox_${agent}"
  local val
  val=$(state_get "$key")
  if [[ -n "$val" ]]; then
    ok "Sandbox $agent: $val (de sessão anterior)"
  else
    echo ""
    echo -e "  ${BOLD}Agente: $agent${NC}"
    echo "  Sandbox ON = bot isolado (recomendado para clientes)"
    echo "  Sandbox OFF = acesso total ao sistema (recomendado para admin)"
    read -r -p "  Activar sandbox? [S/n]: " yn
    [[ "${yn,,}" == "n" ]] && val="off" || val="on"
    state_save "$key" "$val"
  fi
}

configure_sandbox "$AGENT1_NAME"
[[ -n "$AGENT2_NAME" ]] && configure_sandbox "$AGENT2_NAME"

# =============================================================================
# LOCALIZAÇÃO DO PRESTADOR (domicílio)
# =============================================================================
sep
echo -e "${BOLD}LOCALIZAÇÃO — Ponto de partida para serviços ao domicílio${NC}"
echo -e "  (Salta com Enter se não usas serviços ao domicílio)"
echo ""

PROVIDER_ADDRESS=$(state_get "PROVIDER_ADDRESS")
if [[ -n "$PROVIDER_ADDRESS" ]]; then
  ok "Morada: $PROVIDER_ADDRESS (de sessão anterior)"
else
  read -r -p "  Morada completa do prestador (ou Enter para saltar): " PROVIDER_ADDRESS
  [[ -n "$PROVIDER_ADDRESS" ]] && state_save "PROVIDER_ADDRESS" "$PROVIDER_ADDRESS"
fi

PROVIDER_LAT=$(state_get "PROVIDER_LAT")
PROVIDER_LON=$(state_get "PROVIDER_LON")
if [[ -n "$PROVIDER_ADDRESS" && -z "$PROVIDER_LAT" ]]; then
  echo -e "  ${YELLOW}Dica:${NC} usa maps.google.com para obter as coordenadas (clicar com o botão direito)"
  read -r -p "  Latitude (ex: 38.7677): " PROVIDER_LAT
  read -r -p "  Longitude (ex: -9.1387): " PROVIDER_LON
  [[ -n "$PROVIDER_LAT" ]] && state_save "PROVIDER_LAT" "$PROVIDER_LAT"
  [[ -n "$PROVIDER_LON" ]] && state_save "PROVIDER_LON" "$PROVIDER_LON"
fi

# =============================================================================
# RECOLHA DE TOKENS
# =============================================================================
sep
echo -e "${BOLD}TOKENS — Credenciais necessárias${NC}"
echo -e "  Podes saltar (Enter) e configurar depois em ${BOLD}$ENV_FILE${NC}."
sep

ask_token() {
  local var_name="$1" label="$2" hint="$3" current value
  current=$(state_get "$var_name")
  if [[ -n "$current" ]]; then
    ok "$label já configurado"
    printf -v "$var_name" '%s' "$current"
    return
  fi
  echo ""
  echo -e "  ${BOLD}$label${NC}"
  [[ -n "$hint" ]] && echo -e "    ${YELLOW}Onde obter:${NC} $hint"
  read -r -s -p "    Valor (oculto): " value
  echo ""
  if [[ -n "$value" ]]; then
    state_save "$var_name" "$value"
    printf -v "$var_name" '%s' "$value"
    ok "Guardado"
  else
    warn "Saltado — edita $ENV_FILE depois"
    printf -v "$var_name" '%s' ""
  fi
}

ask_text() {
  local var_name="$1" label="$2" hint="$3" current value
  current=$(state_get "$var_name")
  if [[ -n "$current" ]]; then
    ok "$label: $current (de sessão anterior)"
    printf -v "$var_name" '%s' "$current"
    return
  fi
  echo ""
  echo -e "  ${BOLD}$label${NC}"
  [[ -n "$hint" ]] && echo -e "    ${YELLOW}Info:${NC} $hint"
  read -r -p "    Valor: " value
  if [[ -n "$value" ]]; then
    state_save "$var_name" "$value"
    printf -v "$var_name" '%s' "$value"
    ok "Guardado"
  else
    warn "Saltado — edita $ENV_FILE depois"
    printf -v "$var_name" '%s' ""
  fi
}

# LLM
sep
echo -e "${BOLD}LLM — Modelo de linguagem${NC}"

ask_token "ANTHROPIC_API_KEY" \
  "Anthropic API Key (Claude — usado pelo OpenClaw)" \
  "https://console.anthropic.com → API Keys"

ask_token "OPENROUTER_API_KEY" \
  "OpenRouter API Key (opcional — proxy local para outros modelos)" \
  "https://openrouter.ai/keys  |  salta se usas só Anthropic"

# Cal.eu
sep
echo -e "${BOLD}CAL.EU — Agendamento${NC}"

ask_token "CALCOM_API_KEY" \
  "Cal.eu API Key" \
  "https://app.cal.eu → Settings → API Keys"

ask_text "CALCOM_USERNAME" \
  "Cal.eu username (slug do calendário)" \
  "Aparece no URL do teu calendário: cal.eu/{username}"

# Kommo CRM
sep
echo -e "${BOLD}KOMMO CRM${NC}"

ask_text "KOMMO_SUBDOMAIN" \
  "Kommo subdomain" \
  "Se acedes em empresa.kommo.com, o subdomain é 'empresa'"

ask_token "KOMMO_ACCESS_TOKEN" \
  "Kommo Access Token (long-lived)" \
  "Kommo → Configurações → Integrações → API → Long-lived token"

echo ""
warn "IDs de pipeline e status Kommo precisam de configuração manual em $ENV_FILE"
warn "Obtém-os via: GET https://{subdomain}.kommo.com/api/v4/leads/pipelines"

# Cloudflare
sep
echo -e "${BOLD}CLOUDFLARE${NC}"

ask_token "CF_ACCOUNT_ID" \
  "Cloudflare Account ID" \
  "https://dash.cloudflare.com → perfil direito → Account ID"

ask_token "CF_API_TOKEN" \
  "Cloudflare API Token (permissões: Tunnel:Edit + DNS:Edit)" \
  "https://dash.cloudflare.com → My Profile → API Tokens"

CF_DOMAIN=$(state_get "CF_DOMAIN")
if [[ -z "$CF_DOMAIN" ]]; then
  echo ""
  read -r -p "  Domínio base (ex: empresa.com): " CF_DOMAIN
  [[ -z "$CF_DOMAIN" ]] && CF_DOMAIN="CONFIGURAR.com"
  state_save "CF_DOMAIN" "$CF_DOMAIN"
fi
ok "Domínio: $CF_DOMAIN"

# Telegram — bots por agente
sep
echo -e "${BOLD}TELEGRAM — Bots por agente${NC}"
echo -e "  Cria um bot por agente em @BotFather → /newbot"
echo ""

collect_telegram_token() {
  local agent="$1"
  local key="TELEGRAM_TOKEN_${agent^^}"
  ask_token "$key" \
    "Telegram Bot Token — $agent" \
    "Telegram → @BotFather → /newbot"
}

collect_telegram_token "$AGENT1_NAME"
[[ -n "$AGENT2_NAME" ]] && collect_telegram_token "$AGENT2_NAME"

# Telegram — admin
sep
echo -e "${BOLD}TELEGRAM — Notificações admin${NC}"
echo -e "  Bot que envia alertas ao administrador (pode ser o mesmo do agente 2/admin)"
echo ""

ask_token "TELEGRAM_BOT_B_TOKEN" \
  "Telegram Bot Token — bot de notificações admin" \
  "Pode ser o mesmo token do agente admin (ex: flux)"

ask_text "TELEGRAM_ADMIN_ID" \
  "Telegram Admin Chat ID (o teu ID pessoal de utilizador)" \
  "Envia qualquer mensagem a @userinfobot para saber o teu ID"

# Segurança — gerados automaticamente
sep
echo -e "${BOLD}SEGURANÇA — Tokens da API local${NC}"
echo ""

API_TOKEN=$(state_get "API_TOKEN")
if [[ -z "$API_TOKEN" ]]; then
  API_TOKEN=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
  state_save "API_TOKEN" "$API_TOKEN"
  ok "API_TOKEN gerado automaticamente (guarda-o se precisares de chamar a API externamente)"
fi

WEBHOOK_SECRET=$(state_get "WEBHOOK_SECRET")
if [[ -z "$WEBHOOK_SECRET" ]]; then
  WEBHOOK_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
  state_save "WEBHOOK_SECRET" "$WEBHOOK_SECRET"
  ok "WEBHOOK_SECRET gerado automaticamente (configura este valor no Cal.eu)"
fi

# WhatsApp
sep
echo -e "${BOLD}WHATSAPP${NC}"
echo ""
echo "  1) Via OpenClaw CLI (volume baixo, sem conta business — QR code depois)"
echo "  2) Via serviço externo (Z-API / Evolution API — volume alto ou conta business)"
echo "  3) Não usar WhatsApp"
echo ""
WA_MODE=$(state_get "WA_MODE")
if [[ -z "$WA_MODE" ]]; then
  read -r -p "  Opção [1/2/3]: " WA_MODE
  WA_MODE=${WA_MODE:-3}
  state_save "WA_MODE" "$WA_MODE"
fi

WA_TOKEN="" ; WA_PHONE_ID=""
case $WA_MODE in
  1) info "OpenClaw CLI — farás scan do QR code no final" ;;
  2)
    ask_token "WA_TOKEN" "WhatsApp API Token" "Painel do teu serviço WhatsApp"
    ask_token "WA_PHONE_ID" "WhatsApp Phone ID" "Painel do teu serviço WhatsApp"
    ;;
  *) info "WhatsApp não configurado" ;;
esac

# =============================================================================
# CRIAR FICHEIRO .ENV
# =============================================================================
sep
echo -e "${BOLD}A criar $ENV_FILE${NC}"
sep

$SUDO mkdir -p "$ENV_DIR"

# Ler vars dinâmicas antes do heredoc
_TG1_KEY="TELEGRAM_TOKEN_${AGENT1_NAME^^}"
_TG1_VAL="${!_TG1_KEY:-CONFIGURAR}"
_TG2_LINE=""
if [[ -n "$AGENT2_NAME" ]]; then
  _TG2_KEY="TELEGRAM_TOKEN_${AGENT2_NAME^^}"
  _TG2_LINE="TELEGRAM_TOKEN_${AGENT2_NAME^^}=${!_TG2_KEY:-CONFIGURAR}"
fi

$SUDO tee "$ENV_FILE" > /dev/null << EOF
# === ${PROJECT_NAME} — Gerado por setup.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ) ===
# ATENÇÃO: chmod 600. NÃO expor via web. NÃO commitar.

# --- Identidade ---
APP_NAME=${APP_NAME:-SerenBot}
SITE_URL=${SITE_URL:-https://localhost}
BOT_CLIENT_NAME=${BOT_CLIENT_NAME:-Bot}

# --- OpenClaw ---
OPENCLAW_AGENT_NAME=${AGENT1_NAME}

# --- Localização do prestador (para serviços ao domicílio) ---
PROVIDER_ADDRESS=${PROVIDER_ADDRESS:-CONFIGURAR}
PROVIDER_LAT=${PROVIDER_LAT:-0}
PROVIDER_LON=${PROVIDER_LON:-0}

# --- LLM ---
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-CONFIGURAR}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-CONFIGURAR}

# --- Cal.eu ---
CALCOM_API_KEY=${CALCOM_API_KEY:-CONFIGURAR}
CALCOM_USERNAME=${CALCOM_USERNAME:-CONFIGURAR}
CALCOM_TIMEZONE=Europe/Lisbon

# --- Kommo CRM ---
KOMMO_SUBDOMAIN=${KOMMO_SUBDOMAIN:-CONFIGURAR}
KOMMO_ACCESS_TOKEN=${KOMMO_ACCESS_TOKEN:-CONFIGURAR}
KOMMO_RESPONSIBLE_USER_ID=CONFIGURAR
# IDs obtidos via: GET https://{subdomain}.kommo.com/api/v4/leads/pipelines
KOMMO_PIPELINE_ID=CONFIGURAR
KOMMO_PIPELINE_ATIVOS_ID=CONFIGURAR
KOMMO_STATUS_AGENDADO=CONFIGURAR
KOMMO_STATUS_ATIVOS_AGENDADO=CONFIGURAR

# --- Cloudflare ---
CF_ACCOUNT_ID=${CF_ACCOUNT_ID:-CONFIGURAR}
CF_API_TOKEN=${CF_API_TOKEN:-CONFIGURAR}
CF_DOMAIN=${CF_DOMAIN}

# --- Telegram (bots por agente — usados pelo OpenClaw) ---
TELEGRAM_TOKEN_${AGENT1_NAME^^}=${_TG1_VAL}
${_TG2_LINE}

# --- Telegram (admin — notificações da API) ---
TELEGRAM_BOT_B_TOKEN=${TELEGRAM_BOT_B_TOKEN:-CONFIGURAR}
TELEGRAM_ADMIN_ID=${TELEGRAM_ADMIN_ID:-CONFIGURAR}

# --- WhatsApp ---
WA_TOKEN=${WA_TOKEN:-CONFIGURAR}
WA_PHONE_ID=${WA_PHONE_ID:-CONFIGURAR}

# --- Segurança API ---
API_TOKEN=${API_TOKEN}
WEBHOOK_SECRET=${WEBHOOK_SECRET}

# --- Servidor ---
GATEWAY_PORT=18789
API_PORT=3001
NODE_ENV=production
EOF

$SUDO chmod 600 "$ENV_FILE"
$SUDO chown root:root "$ENV_FILE"
ok ".env criado em $ENV_FILE (chmod 600)"

MISSING_COUNT=$(grep -c "=CONFIGURAR" "$ENV_FILE" 2>/dev/null || true)
[[ $MISSING_COUNT -gt 0 ]] && warn "$MISSING_COUNT campos por preencher — edita $ENV_FILE depois"

# =============================================================================
# INSTALAR OPENCLAW
# =============================================================================
sep
echo -e "${BOLD}OPENCLAW${NC}"
sep

if state_done "openclaw_installed" || command -v openclaw >/dev/null 2>&1; then
  ok "OpenClaw: $(openclaw --version 2>/dev/null || echo 'já instalado')"
  state_save "openclaw_installed" "done"
else
  info "A instalar OpenClaw..."
  curl -fsSL https://openclaw.ai/install.sh | bash
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
  export PATH="$HOME/.npm-global/bin:$PATH"
  command -v openclaw >/dev/null 2>&1 || die "OpenClaw não encontrado após instalação. Verifica o PATH e reinicia o terminal."
  ok "OpenClaw instalado: $(openclaw --version)"
  state_save "openclaw_installed" "done"
fi

# =============================================================================
# INSTALAR NODE.JS
# =============================================================================
sep
echo -e "${BOLD}NODE.JS${NC}"
sep

install_nodejs() {
  info "A instalar Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
  ok "Node.js instalado: $(node --version)"
  state_save "nodejs_installed" "done"
}

if state_done "nodejs_installed"; then
  ok "Node.js já instalado (de sessão anterior)"
elif command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node --version 2>/dev/null | tr -d 'v' | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    ok "Node.js: $(node --version)"
    state_save "nodejs_installed" "done"
  else
    warn "Node.js $(node --version) — versão mínima é 18. A actualizar..."
    install_nodejs
  fi
else
  install_nodejs
fi

NODE_BIN=$(command -v node)

# =============================================================================
# DEPENDÊNCIAS NODE (npm install)
# =============================================================================
sep
echo -e "${BOLD}DEPENDÊNCIAS NODE${NC}"
sep

if state_done "npm_installed"; then
  ok "Dependências já instaladas"
else
  [[ -f "$REPO_DIR/package.json" ]] || die "package.json não encontrado em $REPO_DIR — repositório incompleto"
  info "A instalar dependências em $REPO_DIR..."
  (cd "$REPO_DIR" && npm install --production)
  ok "npm install concluído"
  state_save "npm_installed" "done"
fi

# =============================================================================
# INSTALAR CLOUDFLARED
# =============================================================================
sep
echo -e "${BOLD}CLOUDFLARED${NC}"
sep

if state_done "cloudflared_installed" || command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared: $(cloudflared --version 2>/dev/null | head -1 || echo 'já instalado')"
  state_save "cloudflared_installed" "done"
else
  ARCH=$(uname -m)
  case $ARCH in
    x86_64)  CF_ARCH="amd64" ;;
    aarch64) CF_ARCH="arm64" ;;
    armv7l)  CF_ARCH="arm"   ;;
    *) die "Arquitectura não suportada: $ARCH" ;;
  esac
  info "A instalar cloudflared (${CF_ARCH})..."
  TMP_DEB=$(mktemp /tmp/cloudflared-XXXXXX.deb)
  curl -L --output "$TMP_DEB" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}.deb"
  $SUDO dpkg -i "$TMP_DEB"
  rm -f "$TMP_DEB"
  ok "cloudflared instalado: $(cloudflared --version | head -1)"
  state_save "cloudflared_installed" "done"
fi

# =============================================================================
# CLOUDFLARE TUNNEL
# =============================================================================
sep
echo -e "${BOLD}CLOUDFLARE TUNNEL${NC}"
sep

if state_done "cf_tunnel_created"; then
  TUNNEL_UUID=$(state_get "cf_tunnel_uuid")
  ok "Tunnel já criado (UUID: $TUNNEL_UUID)"
else
  echo ""
  echo -e "${YELLOW}Atenção: o próximo passo abre (ou mostra) um URL para autenticares no browser.${NC}"
  echo "Se estás num servidor sem browser, copia o URL e abre no teu computador."
  echo ""
  read -r -p "  Prima Enter para continuar..."

  cloudflared tunnel login

  info "A criar tunnel '${TUNNEL_NAME}'..."
  TUNNEL_OUTPUT=$(cloudflared tunnel create "${TUNNEL_NAME}" 2>&1 || true)

  if echo "$TUNNEL_OUTPUT" | grep -q "already exists"; then
    warn "Tunnel '${TUNNEL_NAME}' já existe — a reutilizar"
    TUNNEL_UUID=$(cloudflared tunnel list 2>/dev/null | grep "^${TUNNEL_NAME}" | awk '{print $1}' || \
      cloudflared tunnel list 2>/dev/null | grep "${TUNNEL_NAME}" | awk '{print $1}' | head -1)
  else
    TUNNEL_UUID=$(echo "$TUNNEL_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  fi

  if [[ -z "$TUNNEL_UUID" ]]; then
    err "Não foi possível obter o UUID do tunnel."
    cloudflared tunnel list
    read -r -p "  Cola o UUID do tunnel '${TUNNEL_NAME}': " TUNNEL_UUID
  fi

  ok "Tunnel UUID: $TUNNEL_UUID"
  state_save "cf_tunnel_created" "done"
  state_save "cf_tunnel_uuid" "$TUNNEL_UUID"
fi

CF_CONFIG_DIR="/etc/cloudflared"
CF_CONFIG_FILE="$CF_CONFIG_DIR/config.yml"
CREDS_FILE="$HOME/.cloudflared/${TUNNEL_UUID}.json"

if [[ ! -f "$CF_CONFIG_FILE" ]]; then
  info "A criar $CF_CONFIG_FILE..."
  $SUDO mkdir -p "$CF_CONFIG_DIR"
  $SUDO tee "$CF_CONFIG_FILE" > /dev/null << CFEOF
tunnel: ${TUNNEL_UUID}
credentials-file: ${CREDS_FILE}

ingress:
  # OpenClaw Gateway — todos os bots
  - hostname: bots.${CF_DOMAIN}
    service: http://localhost:18789
  # API Node.js — webhooks (Cal.eu, Kommo, etc.)
  - hostname: api.${CF_DOMAIN}
    service: http://localhost:3001
  # Catch-all obrigatório
  - service: http_status:404
CFEOF
  ok "Configuração criada em $CF_CONFIG_FILE"
else
  ok "Configuração do tunnel já existe — a manter"
fi

if ! state_done "cf_dns_created" && [[ "$CF_DOMAIN" != "CONFIGURAR.com" ]]; then
  info "A criar registos DNS CNAME no Cloudflare..."
  cloudflared tunnel route dns "${TUNNEL_NAME}" "bots.${CF_DOMAIN}" 2>/dev/null \
    && ok "DNS: bots.${CF_DOMAIN}" \
    || warn "DNS bots: falhou (pode já existir ou domínio não estar no Cloudflare)"
  cloudflared tunnel route dns "${TUNNEL_NAME}" "api.${CF_DOMAIN}" 2>/dev/null \
    && ok "DNS: api.${CF_DOMAIN}" \
    || warn "DNS api: falhou (pode já existir)"
  state_save "cf_dns_created" "done"
fi

# =============================================================================
# INICIALIZAR AGENTES OPENCLAW
# =============================================================================
sep
echo -e "${BOLD}AGENTES OPENCLAW${NC}"
sep

init_agent() {
  local name="$1"
  local sandbox
  sandbox=$(state_get "sandbox_${name}")
  sandbox="${sandbox:-on}"
  local workspace="$HOME/.openclaw/workspace-${name}"

  if state_done "agent_${name}_created"; then
    ok "Agente $name já configurado"
    return
  fi

  info "A inicializar agente: $name (sandbox: $sandbox)"
  mkdir -p "$workspace"

  if openclaw agent list 2>/dev/null | grep -q "^${name}"; then
    warn "Agente $name já existe — a manter"
  else
    openclaw agent init "$name" \
      --workspace "$workspace" \
      --sandbox "$sandbox" 2>/dev/null \
    || warn "openclaw agent init falhou — pode ser versão diferente do CLI"
  fi

  ok "Agente $name pronto (workspace: $workspace)"
  state_save "agent_${name}_created" "done"
}

init_agent "$AGENT1_NAME"
[[ -n "$AGENT2_NAME" ]] && init_agent "$AGENT2_NAME"

# =============================================================================
# SERVIÇOS SYSTEMD
# =============================================================================
sep
echo -e "${BOLD}SERVIÇOS SYSTEMD${NC}"
sep

SCRIPT_USER="${SUDO_USER:-$(whoami)}"
OC_BIN=$(command -v openclaw 2>/dev/null || echo "$HOME/.npm-global/bin/openclaw")

# OpenClaw Gateway
$SUDO tee "/etc/systemd/system/${SVC_GATEWAY}.service" > /dev/null << EOF
[Unit]
Description=OpenClaw Gateway — ${PROJECT_NAME}
After=network.target
Documentation=https://openclaw.ai

[Service]
Type=simple
User=${SCRIPT_USER}
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${ENV_FILE}
ExecStartPre=${OC_BIN} gateway stop --quiet || true
ExecStart=${OC_BIN} gateway start
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
ok "Serviço ${SVC_GATEWAY}.service criado"

# API Node.js
$SUDO tee "/etc/systemd/system/${SVC_API}.service" > /dev/null << EOF
[Unit]
Description=${PROJECT_NAME} API — Node.js
After=network.target ${SVC_GATEWAY}.service

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
ok "Serviço ${SVC_API}.service criado"

# OpenRouter Proxy — só instala se tiver API key configurada
PROXY_SVC_ENABLED=false
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  $SUDO tee "/etc/systemd/system/${SVC_PROXY}.service" > /dev/null << EOF
[Unit]
Description=${PROJECT_NAME} OpenRouter Proxy
After=network.target

[Service]
Type=simple
User=${SCRIPT_USER}
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} src/openrouter-proxy.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  PROXY_SVC_ENABLED=true
  ok "Serviço ${SVC_PROXY}.service criado"
else
  info "OPENROUTER_API_KEY não configurado — proxy não instalado"
  info "Para instalar depois: edita $ENV_FILE e corre este script de novo"
fi

# cloudflared
$SUDO cloudflared service install 2>/dev/null \
  && ok "cloudflared.service instalado" \
  || warn "cloudflared service install falhou — tenta: sudo cloudflared service install"

$SUDO systemctl daemon-reload

SVCS_TO_ENABLE="${SVC_GATEWAY} ${SVC_API}"
[[ "$PROXY_SVC_ENABLED" == "true" ]] && SVCS_TO_ENABLE="${SVCS_TO_ENABLE} ${SVC_PROXY}"
# shellcheck disable=SC2086
$SUDO systemctl enable $SVCS_TO_ENABLE 2>/dev/null || true
ok "Serviços registados e activados"

# =============================================================================
# INICIAR SERVIÇOS
# =============================================================================
sep
echo -e "${BOLD}A INICIAR SERVIÇOS${NC}"
sep

start_svc() {
  local svc="$1"
  info "A iniciar $svc..."
  if $SUDO systemctl start "$svc" 2>/dev/null; then
    sleep 2
    $SUDO systemctl is-active --quiet "$svc" \
      && ok "$svc: running" \
      || warn "$svc: pode não ter iniciado — verifica: journalctl -u $svc -n 30"
  else
    warn "$svc: falhou — verifica: journalctl -u $svc -n 30"
  fi
}

start_svc "${SVC_GATEWAY}"
start_svc "${SVC_API}"
[[ "$PROXY_SVC_ENABLED" == "true" ]] && start_svc "${SVC_PROXY}"
start_svc "cloudflared"

# =============================================================================
# VERIFICAÇÃO FINAL
# =============================================================================
sep
echo -e "${BOLD}VERIFICAÇÃO FINAL${NC}"
sep

check_url() {
  local label="$1" url="$2"
  curl -sf --max-time 5 "$url" >/dev/null 2>&1 \
    && ok "$label: OK" \
    || warn "$label: não responde ($url)"
}

check_url "Gateway local" "http://localhost:18789/health"
check_url "API local"     "http://localhost:3001/health"
[[ "$PROXY_SVC_ENABLED" == "true" ]] && check_url "Proxy local" "http://127.0.0.1:3002/"
[[ "$CF_DOMAIN" != "CONFIGURAR.com" ]] && check_url "Tunnel (bots)" "https://bots.${CF_DOMAIN}/health"

STILL_MISSING=$(grep "=CONFIGURAR" "$ENV_FILE" 2>/dev/null | grep -v "^#" | cut -d= -f1 || true)
if [[ -n "$STILL_MISSING" ]]; then
  echo ""
  warn "Campos por configurar em $ENV_FILE:"
  echo "$STILL_MISSING" | while read -r f; do echo "    - $f"; done
fi

if [[ "$WA_MODE" == "1" ]]; then
  echo ""
  warn "WhatsApp (QR code) — corre agora ou depois:"
  echo "  openclaw connector add whatsapp --agent ${AGENT1_NAME}"
fi

# =============================================================================
# SUMÁRIO
# =============================================================================
sep
echo -e "${BOLD}${GREEN}INSTALAÇÃO CONCLUÍDA — ${PROJECT_NAME}${NC}"
sep

echo ""
echo -e "  ${BOLD}Config${NC}         $ENV_FILE (chmod 600)"
echo -e "  ${BOLD}Código${NC}         $REPO_DIR"
echo -e "  ${BOLD}Gateway${NC}        bots.${CF_DOMAIN} → localhost:18789"
echo -e "  ${BOLD}API${NC}            api.${CF_DOMAIN} → localhost:3001"
[[ "$PROXY_SVC_ENABLED" == "true" ]] && \
  echo -e "  ${BOLD}Proxy${NC}          127.0.0.1:3002 → openrouter.ai"
echo ""
echo -e "  ${BOLD}Comandos úteis:${NC}"
echo "    systemctl status ${SVC_GATEWAY} ${SVC_API} cloudflared"
echo "    journalctl -u ${SVC_API} -f"
echo "    openclaw gateway stop    # antes de reiniciar manualmente"
echo ""
echo -e "  ${BOLD}Webhooks a configurar:${NC}"
echo "    Cal.eu  → https://api.${CF_DOMAIN}/webhook/caleu"
echo "    Kommo   → https://api.${CF_DOMAIN}/webhook/kommo"
echo ""
echo -e "  ${BOLD}API_TOKEN${NC} (para chamadas à API local):"
echo "    ${API_TOKEN}"
echo ""
echo -e "  ${BOLD}WEBHOOK_SECRET${NC} (configurar no Cal.eu → Webhooks):"
echo "    ${WEBHOOK_SECRET}"
echo ""

rm -f "$STATE_FILE"
ok "Estado temporário limpo."
echo ""
