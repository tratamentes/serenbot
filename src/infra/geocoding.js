/**
 * Geocoding e cálculo de distância para serviços ao domicílio.
 * Usa Nominatim (OpenStreetMap) - API gratuita, sem key necessária.
 * Rate limit: máx 1 pedido/segundo.
 */

const logger = require('../utils/logger');
const { createClient } = require('../utils/http');
const geoCache = require('../cache/geocache');

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

const PROVIDER_LOCATION = {
  address: process.env.PROVIDER_ADDRESS || '',
  lat:     parseFloat(process.env.PROVIDER_LAT || '0'),
  lon:     parseFloat(process.env.PROVIDER_LON || '0'),
};

const APP_NAME = process.env.APP_NAME  || 'SerenBot';
const SITE_URL = process.env.SITE_URL  || 'localhost';
const http = createClient(NOMINATIM_BASE, { 'User-Agent': `${APP_NAME}/1.0 (${SITE_URL})` }, 15000);

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1100;

async function waitForRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Remove partes da morada que o Nominatim não consegue processar:
 * andares (2º, R/C), fracções (Dto, Esq, A, B), apartamentos, etc.
 * Mantém: rua, número, código postal, cidade.
 */
function cleanAddressForGeocoding(address) {
  return address
    // "2ºDto", "3ºEsq", "1ºAndar" — número+ordinal seguido de fracção (sem espaço)
    .replace(/\d+[º°ª][a-záàãâéêíóôõúç]*\.?/gi, '')
    // fracções isoladas: Dto, Esq, Dir, Esqdo, Frt, Tras (com \b antes e lookahead)
    .replace(/\b(dto|drt|dir|direito|esq|esqdo|esquerdo|frt|frente|tras|trás)\.?\b/gi, '')
    // andares: 1º, 2.º, R/C, RC, cave, sub-cave, loja, andar
    .replace(/\b(r\/?c|cave|sub-?cave|loja|andar)\b\.?/gi, '')
    // vírgulas duplas ou espaços excessivos deixados pela limpeza
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^,|,$/g, '')
    .trim();
}

async function nominatimSearch(query) {
  await waitForRateLimit();
  const res = await http.get('/search', {
    params: { q: query, format: 'json', limit: 1, addressdetails: 1, countrycodes: 'pt' },
  });
  return res.data?.[0] || null;
}

async function geocodeAddress(address) {
  if (!address || address.trim().length < 5) return null;

  const cacheKey = address.toLowerCase().trim();
  const cached = geoCache.get(cacheKey);
  if (cached) {
    logger.debug('Geocoding cache hit', { address });
    return cached;
  }

  const cleaned = cleanAddressForGeocoding(address);
  let result = null;

  try {
    // Tentativa 1: morada limpa (sem andares/fracções)
    result = await nominatimSearch(cleaned);

    // Tentativa 2: só rua + número (sem código postal), se falhar
    if (!result) {
      const firstPart = cleaned.split(',')[0].trim();
      if (firstPart.length >= 5 && firstPart !== cleaned) {
        result = await nominatimSearch(firstPart + ', Portugal');
      }
    }
  } catch (err) {
    logger.error('Geocoding failed', { address, error: err.message });
    return null;
  }

  if (!result) {
    logger.warn('Geocoding: morada não encontrada', { address, cleaned });
    return null;
  }

  const geo = {
    lat:     parseFloat(result.lat),
    lon:     parseFloat(result.lon),
    display: result.display_name,
  };

  geoCache.set(cacheKey, geo);
  logger.debug('Geocoding success', { address, display: geo.display });
  return geo;
}

async function calculateDistanceFromProvider(clientAddress) {
  const clientGeo = await geocodeAddress(clientAddress);
  
  if (!clientGeo) {
    return { distance: null, clientCoords: null, error: 'Morada não encontrada. Verifique se a morada está correcta.' };
  }

  const distance = haversineDistance(
    PROVIDER_LOCATION.lat,
    PROVIDER_LOCATION.lon,
    clientGeo.lat,
    clientGeo.lon
  );

  return {
    distance: Math.round(distance * 10) / 10,
    clientCoords: { lat: clientGeo.lat, lon: clientGeo.lon },
    clientAddress: clientGeo.display,
    error: null,
  };
}

module.exports = {
  PROVIDER_LOCATION,
  haversineDistance,
  geocodeAddress,
  calculateDistanceFromProvider,
};
