/**
 * Catálogo dinâmico de event types Cal.com
 *
 * Substitui o SLUG_MAP hardcoded em calcom.js.
 * Lê os event types da API, parseia, persiste em disco e serve lookups.
 *
 * Estrutura do catálogo em memória:
 *   catalog.consultorio.lisboa.relaxamento[60] = { slug, id, title, price, hidden, afterEventBuffer }
 *   catalog.consultorio.cascais.terapeutica[90] = { ... }
 *   catalog.domicilio.express[30] = { ... }
 *
 * Para suporte multi-terapeuta no futuro: adicionar nível "username" acima de "consultorio".
 */

const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { createClient } = require('../utils/http');

const BASE_URL = () => process.env.CALCOM_BASE_URL || 'https://api.cal.com/v2';
const API_KEY  = () => process.env.CALCOM_API_KEY;
const USERNAME = () => process.env.CALCOM_USERNAME;

const CATALOG_PATH     = path.join(__dirname, '../../data/calcom-catalog.json');
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;
const DEFAULT_BUFFER   = 30;

// Estado em memória
let _catalog   = null;   // { consultorio: { cidade: { servico: { dur: entry } } }, domicilio: { servico: { dur: entry } } }
let _bySlug    = {};     // slug → parsed entry
let _updatedAt = 0;

// ─── PARSING ──────────────────────────────────────────────────────────────────

function parseEventType(et) {
  const slug  = (et.slug  || '').toLowerCase();
  const title = (et.title || '');

  // Localização
  let location = 'unknown';
  let city     = null;
  if (/domicilio/.test(slug))      { location = 'domicilio'; }
  else if (/cascais/.test(slug))   { location = 'consultorio'; city = 'cascais'; }
  else if (/lisboa/.test(slug))    { location = 'consultorio'; city = 'lisboa'; }

  // Duração: extrai número de "60-min", "90-min", etc.
  const durMatch = slug.match(/(\d+)-min/);
  const duration = durMatch ? parseInt(durMatch[1]) : (et.length || null);

  // Serviço: remove sufixo "-NN-min-cidade" para isolar o nome base
  const base = duration
    ? slug.replace(new RegExp(`-?${duration}-min.*$`), '')
    : slug.replace(/-?(lisboa|cascais|domicilio)$/, '');

  let service;
  if (/plano.?mensal/.test(base))    service = 'plano-mensal';
  else if (/relaxamento/.test(base)) service = 'relaxamento';
  else if (/terapeutica/.test(base)) service = 'terapeutica';
  else if (/express/.test(base))     service = 'express';
  else if (/visceral/.test(base))    service = 'visceral';
  else if (/quantum/.test(base))     service = 'quantum';
  else                               service = base || slug;

  // Preço: extrai "| 65 €" do título
  const priceMatch = title.match(/\|\s*(\d+)\s*€/);
  const price = priceMatch ? parseInt(priceMatch[1]) : null;

  return {
    slug,
    id:               et.id,
    title,
    service,
    duration,
    location,
    city,
    price,
    hidden:           et.hidden   ?? false,
    afterEventBuffer: et.afterEventBuffer ?? DEFAULT_BUFFER,
  };
}

function buildFromParsed(parsed) {
  const catalog = { consultorio: {}, domicilio: {} };
  const bySlug  = {};

  for (const p of parsed) {
    bySlug[p.slug] = p;

    if (!p.duration || p.location === 'unknown') continue;

    const entry = {
      slug:             p.slug,
      id:               p.id,
      title:            p.title,
      price:            p.price,
      hidden:           p.hidden,
      afterEventBuffer: p.afterEventBuffer,
    };

    if (p.location === 'domicilio') {
      if (!catalog.domicilio[p.service]) catalog.domicilio[p.service] = {};
      catalog.domicilio[p.service][p.duration] = entry;
    } else {
      const c = p.city || 'lisboa';
      if (!catalog.consultorio[c])              catalog.consultorio[c] = {};
      if (!catalog.consultorio[c][p.service])   catalog.consultorio[c][p.service] = {};
      catalog.consultorio[c][p.service][p.duration] = entry;
    }
  }

  return { catalog, bySlug };
}

// ─── DISCO ────────────────────────────────────────────────────────────────────

function _save(parsed) {
  try {
    const data = {
      username:  USERNAME(),
      updatedAt: new Date().toISOString(),
      parsed,
    };
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(data, null, 2), 'utf8');
    logger.info('calcom-catalog: guardado', { path: CATALOG_PATH, total: parsed.length });
  } catch (err) {
    logger.warn('calcom-catalog: erro ao guardar', err.message);
  }
}

function _loadSync() {
  try {
    if (!fs.existsSync(CATALOG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// ─── REFRESH DA API ───────────────────────────────────────────────────────────

async function refresh() {
  if (!API_KEY()) {
    logger.warn('calcom-catalog: sem CALCOM_API_KEY — a saltar refresh');
    return false;
  }

  const http = createClient(BASE_URL(), {}, 15000);
  try {
    const res = await http.get('/event-types', {
      params:  { limit: 100 },
      headers: {
        Authorization:     `Bearer ${API_KEY()}`,
        'cal-api-version': '2024-06-14',
      },
    });

    const rawTypes = res.data?.data
                  || res.data?._embedded?.event_types
                  || [];

    const parsed = rawTypes.map(parseEventType);
    const { catalog, bySlug } = buildFromParsed(parsed);

    _catalog   = catalog;
    _bySlug    = bySlug;
    _updatedAt = Date.now();

    _save(parsed);

    const summary = {
      total:   parsed.length,
      visible: parsed.filter(p => !p.hidden).length,
      cities:  Object.keys(catalog.consultorio),
      domicilio: Object.keys(catalog.domicilio),
    };
    logger.info('calcom-catalog: refresh concluído', summary);
    return true;
  } catch (err) {
    logger.error('calcom-catalog: falhou', err?.response?.data || err.message);
    return false;
  }
}

// ─── INICIALIZAÇÃO (chamada no arranque da API) ───────────────────────────────

function initSync() {
  const disk = _loadSync();
  if (!disk?.parsed?.length) return;

  const { catalog, bySlug } = buildFromParsed(disk.parsed);
  _catalog   = catalog;
  _bySlug    = bySlug;
  _updatedAt = new Date(disk.updatedAt).getTime();
  logger.info('calcom-catalog: carregado de disco', {
    updatedAt: disk.updatedAt,
    total: disk.parsed.length,
  });
}

async function init() {
  initSync();
  const age = Date.now() - _updatedAt;
  if (age > REFRESH_INTERVAL) {
    await refresh();
  }
}

// Auto-refresh a cada 24h
setInterval(() => {
  logger.debug('calcom-catalog: auto-refresh');
  refresh().catch(() => {});
}, REFRESH_INTERVAL);

// ─── LOOKUP ───────────────────────────────────────────────────────────────────

/**
 * Resolve o slug correcto do Cal.com para um pedido de agendamento.
 * @param {string}  service     — nome do serviço (parcial, ex: "relaxamento", "terapeut", "express")
 * @param {number}  duration    — duração em minutos
 * @param {boolean} isDomicilio
 * @param {string}  city        — "lisboa" (default) | "cascais"
 * @returns {string|null}
 */
function resolveSlug(service, duration, isDomicilio = false, city = 'lisboa') {
  if (!_catalog) return null;

  const s   = (service || '').toLowerCase();
  const dur = Number(duration);
  const map = isDomicilio
    ? _catalog.domicilio
    : (_catalog.consultorio[(city || 'lisboa').toLowerCase()] || _catalog.consultorio.lisboa || {});

  // Match por substring nos dois sentidos (nome enviado pelo agente vs chave do catálogo)
  for (const [svcKey, durations] of Object.entries(map)) {
    if (s.includes(svcKey) || svcKey.startsWith(s.split(/\s/)[0])) {
      const entry = durations[dur];
      if (entry && !entry.hidden) return entry.slug;
    }
  }

  // Fallback: relaxamento 60 Lisboa (o serviço mais comum)
  return _catalog.consultorio?.lisboa?.relaxamento?.[60]?.slug || null;
}

function getAfterEventBuffer(slug) {
  return _bySlug[slug]?.afterEventBuffer ?? DEFAULT_BUFFER;
}

/**
 * Retorna o catálogo completo para inspecção (ex: endpoint /admin/catalog).
 */
function getCatalog() {
  return {
    updatedAt:  new Date(_updatedAt).toISOString(),
    catalog:    _catalog,
    bySlug:     _bySlug,
  };
}

/**
 * Retorna lista flat de todos os event types (útil para debug).
 */
function listAll() {
  return Object.values(_bySlug);
}

module.exports = {
  init, refresh, initSync,
  resolveSlug, getAfterEventBuffer,
  getCatalog, listAll,
  DEFAULT_BUFFER,
};
