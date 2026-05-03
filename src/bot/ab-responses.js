const fs   = require('fs');
const path = require('path');

const RESPONSES_FILE = path.join(__dirname, '../../data/responses.json');
const STATS_FILE     = path.join(__dirname, '../../data/ab-stats.json');

let responses = {};
let stats     = {};
const counters = {}; // intent → índice round-robin

let statsDirty  = false;
let statsTimer  = null;

function loadResponses() {
  responses = JSON.parse(fs.readFileSync(RESPONSES_FILE, 'utf8'));
}

function loadStats() {
  try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { stats = {}; }
}

function saveStats() {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  statsDirty = false;
}

function scheduleSave() {
  if (!statsDirty) return;
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = null; if (statsDirty) saveStats(); }, 5 * 60 * 1000);
}

function ensureSlot(key, variantId) {
  if (!stats[key]) stats[key] = {};
  if (!stats[key][variantId]) stats[key][variantId] = { shown: 0, continued: 0 };
}

function recordShown(key, variantId) {
  ensureSlot(key, variantId);
  stats[key][variantId].shown++;
  statsDirty = true;
  scheduleSave();
}

function recordContinued(key, variantId) {
  ensureSlot(key, variantId);
  stats[key][variantId].continued++;
  statsDirty = true;
  scheduleSave();
}

function pickVariant(key, session) {
  const entry = responses[key];
  if (!entry?.variants?.length) return null;
  if (!(key in counters)) counters[key] = 0;
  const variant = entry.variants[counters[key] % entry.variants.length];
  counters[key]++;
  if (session) session.lastVariants[key] = variant.id;
  recordShown(key, variant.id);
  return variant.text;
}

function fillTemplate(text, vars) {
  return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

function getStats() { return stats; }
function reload()   { loadResponses(); }

loadResponses();
loadStats();

module.exports = { pickVariant, fillTemplate, recordContinued, getStats, reload };
