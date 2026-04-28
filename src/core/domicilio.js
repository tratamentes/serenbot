/**
 * Configuração de preços e zonas para serviços ao domicílio.
 * 
 * Base: Rua Jorge Colaço 32A, 1700-253 Lisboa
 * Suplemento por zona (ida e volta):
 *   Até 5km  → +5€
 *   Até 10km → +10€
 *   Até 15km → +15€
 *   Até 20km → +20€
 *   Até 25km → +25€
 *   Mais de 25km → Não disponível
 */

const ZONES = {
  RADIUS_5KM:  5,
  RADIUS_10KM: 10,
  RADIUS_15KM: 15,
  RADIUS_20KM: 20,
  RADIUS_25KM: 25,
};

const SURCHARGES = {
  5:  5,
  10: 10,
  15: 15,
  20: 20,
  25: 25,
};

const BASE_PRICES = {
  bliss_60:       60,
  bliss_90:       75,
  relaxante_30:   35,
  relaxante_60:   45,
  relaxante_90:   60,
};

function getPriceKey(service, duration) {
  const s = (service || '').toLowerCase();
  const svc = s.includes('bliss') ? 'bliss' : 'relaxante';
  return `${svc}_${duration}`;
}

function getSurcharge(distanceKm) {
  if (distanceKm <= ZONES.RADIUS_5KM)  return SURCHARGES[5];
  if (distanceKm <= ZONES.RADIUS_10KM) return SURCHARGES[10];
  if (distanceKm <= ZONES.RADIUS_15KM) return SURCHARGES[15];
  if (distanceKm <= ZONES.RADIUS_20KM) return SURCHARGES[20];
  if (distanceKm <= ZONES.RADIUS_25KM) return SURCHARGES[25];
  return null;
}

function getZoneLabel(distanceKm) {
  if (distanceKm <= ZONES.RADIUS_5KM)  return 'Até 5km';
  if (distanceKm <= ZONES.RADIUS_10KM) return 'Até 10km';
  if (distanceKm <= ZONES.RADIUS_15KM) return 'Até 15km';
  if (distanceKm <= ZONES.RADIUS_20KM) return 'Até 20km';
  if (distanceKm <= ZONES.RADIUS_25KM) return 'Até 25km';
  return 'Fora do raio';
}

function getDomicilioPrice(service, duration, distanceKm) {
  const key = getPriceKey(service, duration);
  const basePrice = BASE_PRICES[key] || 0;
  
  if (distanceKm === null || distanceKm === undefined) {
    return { available: false, reason: 'Distância não calculável' };
  }
  
  if (distanceKm > ZONES.RADIUS_25KM) {
    return {
      available: false,
      reason: `Distância (${distanceKm}km) excede o raio máximo de ${ZONES.RADIUS_25KM}km`,
      maxDistance: ZONES.RADIUS_25KM,
      distance: distanceKm,
    };
  }
  
  const surcharge = getSurcharge(distanceKm);
  const zone = getZoneLabel(distanceKm);
  
  return {
    available: true,
    zone,
    basePrice,
    surcharge,
    total: basePrice + surcharge,
    distance: distanceKm,
  };
}

function formatPrice(price) {
  return `${price}€`;
}

module.exports = {
  ZONES,
  SURCHARGES,
  BASE_PRICES,
  getDomicilioPrice,
  getSurcharge,
  getZoneLabel,
  formatPrice,
  getPriceKey,
};
