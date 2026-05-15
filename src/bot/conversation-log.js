const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = path.join(__dirname, '../../data/conversations');

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function safeId(value) {
  return crypto.createHash('sha256').update(String(value || 'unknown')).digest('hex').slice(0, 16);
}

function maskText(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[phone]');
}

function pickAnalysis(analysis) {
  if (!analysis) return null;
  return {
    intent: analysis.intent,
    source: analysis.source,
    sentiment: analysis.sentiment,
    urgency: analysis.urgency,
    risk: analysis.risk,
    confidence: analysis.confidence,
    method: analysis.method,
    stage: analysis.stage,
    bookingBias: analysis.bookingBias,
  };
}

function appendLine(file, entry) {
  ensureDir();
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function logInbound({ chatId, from, text, stateBefore, stateAfter, analysis }) {
  if (process.env.CONVERSATION_LOG_ENABLED === 'false') return;
  const id = safeId(chatId);
  const file = path.join(LOG_DIR, `${id}.jsonl`);
  appendLine(file, {
    time: new Date().toISOString(),
    direction: 'in',
    chatIdHash: id,
    telegramUserIdHash: from?.id ? safeId(from.id) : null,
    username: from?.username || null,
    firstName: from?.first_name || null,
    stateBefore,
    stateAfter,
    text: maskText(text),
    analysis: pickAnalysis(analysis),
  });
}

function logOutbound({ chatId, text, state }) {
  if (process.env.CONVERSATION_LOG_ENABLED === 'false') return;
  const id = safeId(chatId);
  const file = path.join(LOG_DIR, `${id}.jsonl`);
  appendLine(file, {
    time: new Date().toISOString(),
    direction: 'out',
    chatIdHash: id,
    state,
    text: maskText(text),
  });
}

module.exports = { logInbound, logOutbound, maskText };
