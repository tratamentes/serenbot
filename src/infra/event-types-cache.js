/**
 * Cache de configuração dos event types do Cal.eu.
 *
 * Problema: valores como afterEventBuffer estão configurados no Cal.eu
 * e não devem ser duplicados em código — se mudarem lá, quebram aqui.
 *
 * Solução: buscar da API e guardar em memória.
 *   - Refresh automático a cada 24h
 *   - Refresh manual via refresh() (chamado pelo endpoint /admin/refresh-event-types)
 *   - Fallback para DEFAULT_BUFFER se a API falhar
 *
 * Interface: getAfterEventBuffer(slug) → número de minutos
 */

const logger = require('../utils/logger');
const { createClient } = require('../utils/http');

const BASE_URL           = 'https://api.cal.eu/v2';
const REFRESH_INTERVAL   = 24 * 60 * 60 * 1000; // 24 horas
const DEFAULT_BUFFER     = 30;                   // fallback se API falhar

const API_KEY  = () => process.env.CALCOM_API_KEY;
const USERNAME = () => process.env.CALCOM_USERNAME;

const http = createClient(BASE_URL, {}, 15000);

function headers() {
  return {
    Authorization:     `Bearer ${API_KEY()}`,
    'cal-api-version': '2024-06-14',
  };
}

// slug → { afterEventBuffer, length, id, title }
let cache     = null;
let lastFetch = 0;

async function refresh() {
  if (!API_KEY()) {
    logger.warn('event-types-cache: sem API key, a saltar refresh');
    return;
  }

  try {
    const res        = await http.get('/event-types', {
      params:  { username: USERNAME(), limit: 50 },
      headers: headers(),
    });
    const eventTypes = res.data?._embedded?.event_types
                    || res.data?.data
                    || [];

    const map = new Map();
    for (const et of eventTypes) {
      if (et.slug) {
        map.set(et.slug, {
          id:               et.id,
          title:            et.title,
          length:           et.length,          // duração em minutos
          afterEventBuffer: et.afterEventBuffer ?? DEFAULT_BUFFER,
        });
      }
    }

    cache     = map;
    lastFetch = Date.now();
    logger.info(`event-types-cache: ${map.size} event types carregados`, {
      slugs: [...map.keys()],
    });
  } catch (err) {
    logger.error('event-types-cache: falhou a carregar event types', err.message);
    // cache fica como estava — não limpar para não perder dados anteriores
  }
}

async function getEventTypes() {
  if (!cache || Date.now() - lastFetch > REFRESH_INTERVAL) {
    await refresh();
  }
  return cache;
}

async function getAfterEventBuffer(slug) {
  const types = await getEventTypes();
  const et    = types?.get(slug);
  if (!et) {
    logger.debug(`event-types-cache: slug "${slug}" não encontrado, a usar buffer padrão`);
    return DEFAULT_BUFFER;
  }
  return et.afterEventBuffer;
}

// Refresh automático a cada 24h (depois do primeiro pedido)
// Não inicia imediatamente para não bloquear o arranque da API
setInterval(async () => {
  logger.debug('event-types-cache: refresh automático');
  await refresh();
}, REFRESH_INTERVAL);

module.exports = { refresh, getEventTypes, getAfterEventBuffer, DEFAULT_BUFFER };
