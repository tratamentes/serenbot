/**
 * Cal.com / Cal.eu API v2
 * Base URL configurável via CALCOM_BASE_URL:
 *   cal.com → https://api.cal.com/v2  (default)
 *   cal.eu  → https://api.cal.eu/v2
 */

const logger  = require('../utils/logger');
const { createClient } = require('../utils/http');
const { normalizePhone } = require('../utils/phone');
const { getLisbonOffset, toIsoLisbon } = require('../utils/time');
const { mapCalcomToUnified } = require('../core/models');
const catalog = require('./calcom-catalog');

const BASE_URL = process.env.CALCOM_BASE_URL || 'https://api.cal.com/v2';
const USERNAME = () => process.env.CALCOM_USERNAME;
const TZ       = () => process.env.CALCOM_TIMEZONE  || 'Europe/Lisbon';
const API_KEY  = () => process.env.CALCOM_API_KEY;

function hasCalcom() { return !!API_KEY(); }

const http = createClient(BASE_URL, {}, 10000);

function headers(version = '2024-09-04') {
  return {
    Authorization:     `Bearer ${API_KEY()}`,
    'cal-api-version': version,
  };
}

// ─── RESOLUÇÃO DE SLUG ────────────────────────────────────────────────────────
// Delegado ao catálogo dinâmico (calcom-catalog.js).
// Os slugs são lidos de data/calcom-catalog.json (gerado pela API do Cal.com).
// Para forçar actualização: POST /admin/refresh-event-types

function resolveSlug(service, duration, isDomicilio = false, city = 'lisboa') {
  return catalog.resolveSlug(service, duration, isDomicilio, city);
}

// ─── SLOTS DISPONÍVEIS ────────────────────────────────────────────────────────

async function getAvailableSlots(dateStr, duration = 60, service = '', isDomicilio = false, city = 'lisboa') {
  if (!hasCalcom()) return [];

  const slug = resolveSlug(service, duration, isDomicilio, city);
  if (!slug) { logger.warn(`Sem slug para service="${service}" duration=${duration} city=${city}`); return []; }

  const offset = getLisbonOffset(dateStr);
  const start  = `${dateStr}T09:00:00${offset}`;
  const end    = `${dateStr}T22:00:00${offset}`;

  try {
    const res = await http.get('/slots', {
      headers: headers(),
      params:  { eventTypeSlug: slug, username: USERNAME(), start, end, timeZone: TZ() },
    });
    const byDay = res.data?.data || {};
    const raw   = Object.values(byDay).flat();
    logger.debug(`Cal.com: ${raw.length} slots para ${dateStr} (${slug})`);
    return raw.map(s => ({ time: s.start, datetime: new Date(s.start) }));
  } catch (err) {
    logger.error('Cal.com getAvailableSlots falhou', err?.response?.data || err.message);
    return [];
  }
}

// ─── CRIAR RESERVA ────────────────────────────────────────────────────────────

function resolveEmail(email, phone) {
  if (email) return email;
  const domain = (process.env.SITE_URL || 'localhost').replace(/^https?:\/\//, '');
  if (phone) {
    const clean = phone.replace(/[^\d]/g, '');
    return `no-reply+${clean}@${domain}`;
  }
  return `sem-email@${domain}`;
}

async function createBooking({ duration, startTime, name, email, phone, nif, service, notes, isDomicilio = false, language = 'pt', city = 'lisboa' }) {
  if (!hasCalcom()) { logger.warn('Cal.eu: sem API key'); return null; }

  const slug            = resolveSlug(service, duration, isDomicilio, city);
  const normalizedPhone = normalizePhone(phone);
  const resolvedEmail   = resolveEmail(email, phone);

  const bookingFieldsResponses = {};
  if (normalizedPhone) bookingFieldsResponses.attendeePhoneNumber = normalizedPhone;
  if (nif)             bookingFieldsResponses.NIF = nif;
  if (email)           bookingFieldsResponses.email = email;
  if (language)        bookingFieldsResponses.language = language;

  try {
    const res = await http.post('/bookings', {
      start:         startTime,
      eventTypeSlug: slug,
      username:      USERNAME(),
      attendee: {
        name,
        email:       resolvedEmail,
        phoneNumber: normalizedPhone || undefined,
        timeZone:    TZ(),
        language:    language || 'pt',
      },
      bookingFieldsResponses: Object.keys(bookingFieldsResponses).length ? bookingFieldsResponses : undefined,
      metadata: notes ? { notes } : {},
    }, { headers: headers('2024-08-13') });

    const booking = res.data?.data;
    logger.info('Reserva criada', { uid: booking?.uid, start: startTime, name });
    return mapCalcomToUnified(booking);
  } catch (err) {
    const errorData = err?.response?.data;
    logger.error('Cal.eu createBooking falhou', errorData || err.message);

    let field   = null;
    let message = errorData?.error?.message || err.message;
    const match = message.match(/\{(\w+)\}(\w+)/);
    if (match) {
      field = match[1];
      const errorType = match[2];
      if (field === 'attendeePhoneNumber' && errorType === 'invalid_number') {
        message = 'Número de telemóvel inválido';
      } else if (field === 'email' && errorType === 'invalid_email') {
        message = 'Endereço de email inválido';
      }
    }
    const structuredError = new Error(message);
    structuredError.field  = field;
    structuredError.status = err.response?.status;
    throw structuredError;
  }
}

// ─── CANCELAR RESERVA ─────────────────────────────────────────────────────────

async function cancelBooking(bookingUid, reason = '') {
  if (!hasCalcom()) return;
  try {
    await http.post(`/bookings/${bookingUid}/cancel`, { cancellationReason: reason }, { headers: headers('2024-08-13') });
    logger.info('Reserva cancelada', { bookingUid });
  } catch (err) {
    logger.error('Cal.eu cancelBooking falhou', err?.response?.data || err.message);
    throw err;
  }
}

// ─── REAGENDAR RESERVA ────────────────────────────────────────────────────────

async function rescheduleBooking(bookingUid, newStartTime, reason = '') {
  if (!hasCalcom()) return null;
  try {
    const res = await http.post(
      `/bookings/${bookingUid}/reschedule`,
      { start: newStartTime, rescheduledBy: resolveEmail(null, null) },
      { headers: headers('2024-08-13') }
    );
    const booking = res.data?.data;
    logger.info('Reserva reagendada', { oldUid: bookingUid, newUid: booking?.uid, start: newStartTime });
    return mapCalcomToUnified(booking);
  } catch (err) {
    logger.error('Cal.eu rescheduleBooking falhou', err?.response?.data || err.message);
    throw err;
  }
}

// ─── LOOKUP CLIENTE (por email ou telefone) ───────────────────────────────────

async function findClient({ email, phone }) {
  if (!hasCalcom()) return null;

  const normalizedPhone = phone ? normalizePhone(phone) : null;
  const queries = [];
  if (email && !email.startsWith('sem-email') && !email.startsWith('no-reply')) {
    queries.push({ attendeeEmail: email });
  }
  if (normalizedPhone) {
    queries.push({ attendeePhoneNumber: normalizedPhone });
  }
  if (!queries.length) return null;

  for (const params of queries) {
    try {
      const res = await http.get('/bookings', {
        headers: headers('2024-08-13'),
        params:  { ...params, take: 5 },
      });
      const bookings = res.data?.data || [];
      const found = bookings
        .filter(b => b.attendees?.length)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .find(b => {
          const att = b.attendees[0];
          return att.name && att.email &&
            !att.email.startsWith('sem-email') &&
            !att.email.startsWith('no-reply');
        });
      if (found) {
        const att    = found.attendees[0];
        const fields = found.bookingFieldsResponses || {};
        return {
          name:  att.name,
          email: att.email,
          phone: att.phoneNumber || null,
          nif:   fields.NIF || null,
        };
      }
    } catch (err) {
      logger.warn('Cal.eu findClient falhou', err?.response?.data || err.message);
    }
  }
  return null;
}

// ─── RESERVAS DE UM CLIENTE ESPECÍFICO ────────────────────────────────────────

/**
 * Pesquisa reservas futuras directamente por email ou telefone.
 * Evita ter de buscar 100 reservas e filtrar — usa os parâmetros nativos da API.
 */
async function getBookingsByContact({ email, phone }) {
  if (!hasCalcom()) return [];

  const normalizedPhone = phone ? normalizePhone(phone) : null;
  const queries = [];
  if (email && !email.startsWith('sem-email') && !email.startsWith('no-reply')) {
    queries.push({ attendeeEmail: email });
  }
  if (normalizedPhone) {
    queries.push({ attendeePhoneNumber: normalizedPhone });
  }
  if (!queries.length) return [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const seen    = new Set();
  const results = [];

  for (const params of queries) {
    try {
      const afterStart = today.toISOString();
      const res = await http.get('/bookings', {
        headers: headers('2024-08-13'),
        params:  { ...params, afterStart, take: 20 },
      });
      for (const b of res.data?.data || []) {
        if (!seen.has(b.uid) && (b.status === 'accepted' || b.status === 'pending') && new Date(b.start) >= today) {
          seen.add(b.uid);
          results.push(b);
        }
      }
    } catch (err) {
      logger.warn('Cal.eu getBookingsByContact falhou', err?.response?.data || err.message);
    }
  }

  return results
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, 5);
}

// ─── PRÓXIMAS RESERVAS (admin / uso interno) ──────────────────────────────────

async function getUpcomingBookings(limit = 10) {
  if (!hasCalcom()) return [];
  try {
    const res = await http.get('/bookings', {
      headers: headers('2024-08-13'),
      params:  { take: limit },
    });
    const all = res.data?.data || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return all
      .filter(b => b.status === 'accepted' && new Date(b.start) >= today)
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .map(b => mapCalcomToUnified(b));
  } catch (err) {
    logger.error('Cal.eu getUpcomingBookings falhou', err?.response?.data || err.message);
    return [];
  }
}

async function getBookingsByDate(date) {
  if (!hasCalcom()) return [];
  const dayStart = new Date(`${date}T00:00:00Z`);
  const dayEnd   = new Date(`${date}T23:59:59Z`);
  try {
    const res = await http.get('/bookings', {
      headers: headers('2024-08-13'),
      params:  { afterStart: dayStart.toISOString(), take: 50 },
    });
    return (res.data?.data || [])
      .filter(b => {
        const start = new Date(b.start);
        return (b.status === 'accepted' || b.status === 'pending') && start >= dayStart && start <= dayEnd;
      })
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .map(b => mapCalcomToUnified(b));
  } catch (err) {
    logger.error('Cal.eu getBookingsByDate falhou', err?.response?.data || err.message);
    return [];
  }
}

async function getBookingByUid(uid) {
  if (!hasCalcom()) return null;
  try {
    const res = await http.get(`/bookings/${uid}`, { headers: headers('2024-08-13') });
    return mapCalcomToUnified(res.data?.data) || null;
  } catch (err) {
    logger.warn('Cal.eu getBookingByUid falhou', err?.response?.data || err.message);
    return null;
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function parseDate(dateStr) {
  return new Date(dateStr);
}

function isValidService(service, duration) {
  const s = (service || '').toLowerCase();
  const d = Number(duration);
  if (s.includes('express'))                        return d === 30;
  if (s.includes('quantum') || s.includes('visceral')) return d === 60;
  if (s.includes('relaxa') || s.includes('terape')) return [60, 90].includes(d);
  return false;
}

async function registerWebhook(subscriberUrl, triggers) {
  if (!hasCalcom()) {
    logger.warn('Cal.eu não configurado — não é possível registar webhook');
    return null;
  }
  try {
    const eventTypesRes = await http.get('/event-types', {
      params: { limit: 50 },
      headers: headers('2024-06-14'),
    });
    const eventTypes = eventTypesRes.data?._embedded?.event_types || [];
    logger.info('Event types encontrados no Cal.eu', { count: eventTypes.length });

    const results = [];
    for (const eventType of eventTypes) {
      try {
        const res = await http.post(`/event-types/${eventType.id}/webhooks`, {
          subscriberUrl,
          active:   true,
          triggers,
          name:     'mbtp-webhook',
        }, { headers: headers('2024-08-13') });
        results.push({ eventTypeId: eventType.id, slug: eventType.slug, webhookId: res.data?.data?.id });
        logger.info('Webhook registado para event type', { eventTypeId: eventType.id, slug: eventType.slug });
      } catch (err) {
        if (err?.response?.status !== 409) {
          logger.warn('Erro ao registar webhook para event type', { eventTypeId: eventType.id, error: err.message });
        }
      }
    }
    return results;
  } catch (err) {
    logger.error('Erro ao registar webhooks Cal.eu', err?.response?.data || err.message);
    return null;
  }
}

module.exports = {
  getAvailableSlots, createBooking, cancelBooking, rescheduleBooking,
  getUpcomingBookings, getBookingsByContact, getBookingsByDate, findClient, getBookingByUid,
  toIsoLisbon, parseDate, isValidService, registerWebhook, hasCalcom,
  resolveSlug,
};
