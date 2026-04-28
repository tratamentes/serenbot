#!/usr/bin/env bash
# =============================================================================
# OpenClaw Bot System — Setup Wizard (agnóstico)
# =============================================================================
# Uso: bash setup.sh [--only agent1|agent2|all]
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
STATE_FILE="/tmp/.openclaw_setup_state"
declare -A STATE=()

state_save() { echo "$1=$2" >> "$STATE_FILE"; }
state_load() {
  [[ -f "$STATE_FILE" ]] || return
  while IFS='=' read -r k v; do STATE["$k"]="$v"; done < "$STATE_FILE"
}
state_get() { echo "${STATE[$1]:-}"; }
state_done() { [[ "$(state_get "$1")" == "done" ]]; }

state_load

# =============================================================================
# BANNER
# =============================================================================
clear
echo -e "${BOLD}${CYAN}"
cat << 'BANNER'
  ╔══════════════════════════════════════════╗
  ║   OpenClaw Bot System — Setup Wizard    ║
  ║   OpenClaw · Cloudflare Tunnels · Bots  ║
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
  echo -e "  Exemplos: ${YELLOW}myapp${NC}, ${YELLOW}salon${NC}, ${YELLOW}clinic${NC}"
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

# Sandbox por agente
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
# RECOLHA DE TOKENS
# =============================================================================
sep
echo -e "${BOLD}TOKENS — Credenciais necessárias${NC}"
echo -e "Podes saltar (Enter) e configurar depois em ${BOLD}$ENV_FILE${NC}."
sep

ask_token() {
  local var_name="$1"
  local label="$2"
  local hint="$3"
  local current
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

ask_token "ANTHROPIC_API_KEY" \
  "Anthropic API Key" \
  "https://console.anthropic.com → API Keys"

echo ""
echo -e "${BOLD}Integrações opcionais — salta as que não usas${NC}"

ask_token "CAL_EU_API_KEY" \
  "Cal.eu API Key (agendamento)" \
  "https://app.cal.eu → Settings → API Keys"

ask_token "KOMMO_API_KEY" \
  "Kommo CRM API Key" \
  "https://app.kommo.com → Integrações → API"

KOMMO_ACCOUNT_URL=$(state_get "KOMMO_ACCOUNT_URL")
if [[ -z "$KOMMO_ACCOUNT_URL" ]]; then
  read -r -p "  URL da conta Kommo (ex: https://empresa.kommo.com): " KOMMO_ACCOUNT_URL
  [[ -z "$KOMMO_ACCOUNT_URL" ]] && KOMMO_ACCOUNT_URL=""
  [[ -n "$KOMMO_ACCOUNT_URL" ]] && state_save "KOMMO_ACCOUNT_URL" "$KOMMO_ACCOUNT_URL"
fi

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

# Telegram por agente
sep
echo -e "${BOLD}TELEGRAM${NC}"
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

$SUDO tee "$ENV_FILE" > /dev/null << EOF
# === ${PROJECT_NAME} — Gerado por setup.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ) ===
# ATENÇÃO: chmod 600. NÃO expor via web. NÃO commitar.

# --- LLM ---
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-CONFIGURAR}

# --- Cal.eu ---
CAL_EU_API_KEY=${CAL_EU_API_KEY:-CONFIGURAR}
CAL_EU_BASE_URL=https://api.cal.eu/v2

# --- Kommo CRM ---
KOMMO_API_KEY=${KOMMO_API_KEY:-CONFIGURAR}
KOMMO_ACCOUNT_URL=${KOMMO_ACCOUNT_URL:-CONFIGURAR}

# --- Cloudflare ---
CF_ACCOUNT_ID=${CF_ACCOUNT_ID:-CONFIGURAR}
CF_API_TOKEN=${CF_API_TOKEN:-CONFIGURAR}
CF_DOMAIN=${CF_DOMAIN}

# --- Telegram ---
$(
  key1="TELEGRAM_TOKEN_${AGENT1_NAME^^}"
  echo "TELEGRAM_TOKEN_${AGENT1_NAME^^}=${!key1:-CONFIGURAR}"
  if [[ -n "$AGENT2_NAME" ]]; then
    key2="TELEGRAM_TOKEN_${AGENT2_NAME^^}"
    echo "TELEGRAM_TOKEN_${AGENT2_NAME^^}=${!key2:-CONFIGURAR}"
  fi
)

# --- WhatsApp ---
WA_TOKEN=${WA_TOKEN:-CONFIGURAR}
WA_PHONE_ID=${WA_PHONE_ID:-CONFIGURAR}

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

# Configuração do tunnel
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

# Registos DNS
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
  local sandbox_key="sandbox_${name}"
  local sandbox
  sandbox=$(state_get "$sandbox_key")
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
OC_WORKDIR="$(pwd)"
OC_BIN=$(command -v openclaw 2>/dev/null || echo "$HOME/.npm-global/bin/openclaw")
NODE_BIN=$(command -v node 2>/dev/null || echo "/usr/local/bin/node")

# OpenClaw Gateway
$SUDO tee "/etc/systemd/system/${SVC_GATEWAY}.service" > /dev/null << EOF
[Unit]
Description=OpenClaw Gateway — ${PROJECT_NAME}
After=network.target
Documentation=https://openclaw.ai

[Service]
Type=simple
User=${SCRIPT_USER}
WorkingDirectory=${OC_WORKDIR}
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
WorkingDirectory=${OC_WORKDIR}
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

# cloudflared
$SUDO cloudflared service install 2>/dev/null \
  && ok "cloudflared.service instalado" \
  || warn "cloudflared service install falhou — tenta: sudo cloudflared service install"

$SUDO systemctl daemon-reload
$SUDO systemctl enable "${SVC_GATEWAY}" "${SVC_API}" 2>/dev/null || true
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
start_svc "cloudflared"

# =============================================================================
# VERIFICAÇÃO FINAL
# =============================================================================
sep
echo -e "${BOLD}VERIFICAÇÃO FINAL${NC}"
sep

check_url() {
  local label="$1"; local url="$2"
  curl -sf --max-time 5 "$url" >/dev/null 2>&1 \
    && ok "$label: OK" \
    || warn "$label: não responde ($url)"
}

check_url "Gateway local" "http://localhost:18789/health"
check_url "API local" "http://localhost:3001/health"
[[ "$CF_DOMAIN" != "CONFIGURAR.com" ]] && check_url "Tunnel (bots)" "https://bots.${CF_DOMAIN}/health"

# Campos por preencher
STILL_MISSING=$(grep "=CONFIGURAR" "$ENV_FILE" 2>/dev/null | grep -v "^#" | cut -d= -f1 || true)
if [[ -n "$STILL_MISSING" ]]; then
  warn "Campos por configurar em $ENV_FILE:"
  echo "$STILL_MISSING" | while read -r f; do echo "    - $f"; done
fi

# WhatsApp QR
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
echo -e "  ${BOLD}Gateway${NC}        bots.${CF_DOMAIN} → localhost:18789"
echo -e "  ${BOLD}API${NC}            api.${CF_DOMAIN} → localhost:3001"
echo ""
echo -e "  ${BOLD}Comandos úteis:${NC}"
echo "    systemctl status ${SVC_GATEWAY} ${SVC_API} cloudflared"
echo "    journalctl -u ${SVC_GATEWAY} -f"
echo "    openclaw gateway stop    # antes de reiniciar manualmente"
echo ""
echo -e "  ${BOLD}Webhooks a configurar:${NC}"
echo "    Cal.eu  → https://api.${CF_DOMAIN}/webhook/cal"
echo "    Kommo   → https://api.${CF_DOMAIN}/webhook/kommo"
echo ""

rm -f "$STATE_FILE"
ok "Estado temporário limpo."
echo ""
