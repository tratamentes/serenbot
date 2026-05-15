const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createClient } = require('../utils/http');
const logger = require('../utils/logger');
const { classifyIntentDetailed, classifySourceDetailed } = require('./intent');

const USAGE_FILE = path.join(__dirname, '../../data/llm-usage.json');
const AUDIENCE_FILE = path.join(__dirname, '../../data/audience-questions.json');
const OPENROUTER = createClient('https://openrouter.ai', {}, 8000);

const INTENTS = ['greeting', 'booking', 'services', 'pricing', 'location', 'hours', 'cancel', 'affirmative', 'inappropriate', 'unknown'];
const SOURCES = ['terapeutica', 'relaxamento', 'lomi', 'sueca', 'visceral', 'quantum', null];
const SENTIMENTS = ['neutral', 'positive', 'confused', 'frustrated', 'price_sensitive', 'urgent', 'inappropriate'];
const URGENCIES = ['low', 'medium', 'high'];
const RISKS = ['normal', 'inappropriate', 'angry', 'spam', 'medical_red_flag'];

const INPUT_EUR_PER_M = Number(process.env.LLM_INTENT_INPUT_EUR_PER_M || '0.10');
const OUTPUT_EUR_PER_M = Number(process.env.LLM_INTENT_OUTPUT_EUR_PER_M || '0.40');

const DEFAULT_REPLY = 'Isso está fora do que posso ajudar. Posso marcar uma sessão ou responder a dúvidas sobre os nossos tratamentos.';

const cache = new Map();
let audienceEntries = [];

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function loadAudienceEntries() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUDIENCE_FILE, 'utf8'));
    audienceEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    audienceEntries = [];
  }
}

function analyzeAudience(text) {
  const s = normalize(text);
  let best = null;
  for (const entry of audienceEntries) {
    const patterns = Array.isArray(entry.patterns) ? entry.patterns : [];
    const score = patterns.filter(pattern => s.includes(normalize(pattern))).length;
    if (score > 0 && (!best || score > best.score)) best = { ...entry, score };
  }
  if (!best) return null;
  return {
    intent: best.intent || 'unknown',
    source: best.source || null,
    sentiment: best.emotion || 'neutral',
    urgency: best.emotion === 'acute_pain' ? 'high' : 'medium',
    risk: 'normal',
    confidence: Math.min(0.96, 0.72 + best.score * 0.08),
    stage: best.stage || null,
    replyKey: best.reply_key || null,
    bookingBias: !!best.booking_bias,
  };
}

function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function readUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch { return {}; }
}

function writeUsage(usage) {
  const tmp = `${USAGE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(usage, null, 2));
  fs.renameSync(tmp, USAGE_FILE);
}

function currentSpendEur() {
  const usage = readUsage();
  return Number(usage[monthKey()]?.eur || 0);
}

function budget() {
  return {
    monthly: Number(process.env.LLM_INTENT_MONTHLY_BUDGET_EUR || '5'),
    hard: Number(process.env.LLM_INTENT_MONTHLY_HARD_LIMIT_EUR || '15'),
  };
}

function llmEnabled() {
  return process.env.LLM_INTENT_ENABLED === 'true' && !!process.env.OPENROUTER_API_KEY;
}

function shouldUseLlm(local, text) {
  if (!llmEnabled()) return false;
  if (!text || text.length > 500) return false;
  const { monthly, hard } = budget();
  const spent = currentSpendEur();
  if (spent >= Math.min(monthly, hard)) return false;
  if (local.intent.intent === 'unknown') return true;
  if (local.intent.confidence < 0.68) return true;
  if (!local.source.source && /dor|dores|stress|ansiedade|massagem|sess[aã]o|marcar|pre[cç]o/i.test(text)) return true;
  return false;
}

function parseJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function clampChoice(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeLlmResult(data) {
  if (!data || typeof data !== 'object') return null;
  const confidence = Math.max(0, Math.min(0.99, Number(data.confidence || 0)));
  return {
    intent: clampChoice(data.intent, INTENTS, 'unknown'),
    source: clampChoice(data.source ?? null, SOURCES, null),
    sentiment: clampChoice(data.sentiment, SENTIMENTS, 'neutral'),
    urgency: clampChoice(data.urgency, URGENCIES, 'low'),
    risk: clampChoice(data.risk, RISKS, 'normal'),
    confidence,
    reason: typeof data.reason === 'string' ? data.reason.slice(0, 120) : '',
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function recordUsage(usage) {
  const promptTokens = Number(usage?.prompt_tokens || usage?.promptTokens || 0);
  const completionTokens = Number(usage?.completion_tokens || usage?.completionTokens || 0);
  const input = promptTokens || 300;
  const output = completionTokens || 80;
  const eur = (input / 1_000_000) * INPUT_EUR_PER_M + (output / 1_000_000) * OUTPUT_EUR_PER_M;
  const all = readUsage();
  const key = monthKey();
  if (!all[key]) all[key] = { inputTokens: 0, outputTokens: 0, calls: 0, eur: 0 };
  all[key].inputTokens += input;
  all[key].outputTokens += output;
  all[key].calls++;
  all[key].eur = Number((all[key].eur + eur).toFixed(6));
  writeUsage(all);
}

async function callOpenRouter(text, local) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.LLM_INTENT_MODEL || 'google/gemini-2.5-flash-lite';
  const system = [
    'Classifica mensagens de clientes da Tratamentes.',
    'Devolve apenas JSON valido, sem markdown.',
    `intent: ${INTENTS.join('|')}`,
    'source: terapeutica|relaxamento|lomi|sueca|visceral|quantum|null',
    `sentiment: ${SENTIMENTS.join('|')}`,
    `urgency: ${URGENCIES.join('|')}`,
    `risk: ${RISKS.join('|')}`,
    'Nao tomes decisoes de negocio, nao marques reservas, nao escrevas resposta para cliente.',
  ].join('\n');

  const { data } = await OPENROUTER.post('/api/v1/chat/completions', {
    model,
    max_tokens: Number(process.env.LLM_INTENT_MAX_TOKENS || '120'),
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ text, local }) },
    ],
  }, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.SITE_URL || 'https://api.tratamentes.pt',
      'X-Title': process.env.APP_NAME || 'SerenBot',
    },
  });

  recordUsage(data?.usage || {
    prompt_tokens: estimateTokens(system) + estimateTokens(text) + 80,
    completion_tokens: estimateTokens(data?.choices?.[0]?.message?.content || ''),
  });

  return normalizeLlmResult(parseJsonObject(data?.choices?.[0]?.message?.content));
}

async function analyzeIntent(text, session = {}) {
  const local = {
    intent: classifyIntentDetailed(text),
    source: classifySourceDetailed(text),
  };
  const audience = analyzeAudience(text);

  const base = {
    intent: audience?.intent || local.intent.intent,
    source: audience?.source || local.source.source || session.source || null,
    sentiment: audience?.sentiment || 'neutral',
    urgency: 'low',
    risk: local.intent.intent === 'inappropriate' ? 'inappropriate' : 'normal',
    confidence: Math.max(audience?.confidence || 0, local.intent.confidence, local.source.confidence * 0.8),
    method: audience ? 'audience' : 'local',
    stage: audience?.stage || null,
    replyKey: audience?.replyKey || null,
    bookingBias: audience?.bookingBias || false,
    local,
  };

  if (!shouldUseLlm(local, text)) return base;

  const key = crypto.createHash('sha256').update(String(text).toLowerCase().trim()).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return { ...base, ...hit.value, method: 'llm_cache', local };

  try {
    const llm = await callOpenRouter(text, local);
    if (!llm) return base;
    cache.set(key, { value: llm, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    logger.info('intent-analyzer llm', {
      intent: llm.intent,
      source: llm.source,
      sentiment: llm.sentiment,
      urgency: llm.urgency,
      risk: llm.risk,
      confidence: llm.confidence,
      spentEur: currentSpendEur(),
    });
    return { ...base, ...llm, method: 'llm', local };
  } catch (err) {
    logger.warn('intent-analyzer llm falhou', err.message);
    return base;
  }
}

module.exports = { analyzeIntent, DEFAULT_REPLY };

loadAudienceEntries();
