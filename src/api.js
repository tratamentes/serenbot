/**
 * SerenBot API — backend de agendamento e bot Telegram nativo (Seren Lite).
 * Corre em localhost:3002 via EnvironmentFile /opt/serenbot/.env
 */
require('dotenv').config();

const express   = require('express');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');

const {
  toIsoLisbon, getBookingByUid,
  getAvailableSlots, createBooking, cancelBooking, rescheduleBooking,
  getBookingsByContact, getBookingsByDate, findClient, resolveSlug,
} = require('./infra/calcom');
const catalog = require('./infra/calcom-catalog');
const { getAfterEventBuffer } = catalog;

const { selectSlots }                         = require('./core/slots');
const { handleCalEuWebhook }                  = require('./infra/webhook');
const { notifyBooking, notifyCancel, notifyReschedule, sendToAdmin, notifyOtp } = require('./infra/notify');
const { handleUpdate: serenHandleUpdate }     = require('./bot/seren-handler');
const { getStats: getAbStats, reload: reloadResponses } = require('./bot/ab-responses');
const logger                                  = require('./utils/logger');
const { calculateDistanceFromProvider, PROVIDER_LOCATION } = require('./infra/geocoding');
const { getDomicilioPrice, ZONES }            = require('./core/domicilio');
const {
  findClientByPhone, findClientByTelegramId,
  createOrUpdateLead, syncBookingToKommo,
} = require('./infra/kommo');
const { getContext } = require('./utils/graph-context');

const app  = express();
app.set('trust proxy', 1);
app.use(express.json());

const PORT = parseInt(process.env.API_PORT || '3002', 10);

const API_TOKEN             = process.env.API_TOKEN;
const WEBHOOK_SECRET        = process.env.WEBHOOK_SECRET;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const BOT_NAME       = process.env.BOT_CLIENT_NAME || 'Bot';

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────

/**
 * Middleware para garantir que o utilizador tem uma Lead/Contacto no Kommo.
 * Bloqueia acções de agendamento se não houver identificação.
 */
async function ensureCustomer(req, res, next) {
  const { telegram_id, phone, name } = { ...req.query, ...req.body };
  
  if (!telegram_id && !phone) {
    return res.status(403).json({ error: 'Identificação necessária para esta acção.' });
  }

  try {
    let client = telegram_id ? await findClientByTelegramId(telegram_id) : await findClientByPhone(phone);
    
    if (!client && name) {
      // Criar prospecto se não existir
      logger.info('Novo prospecto detectado, a criar no Kommo', { name, telegram_id, phone });
      await createOrUpdateLead({
        name, phone, telegramId: telegram_id,
        source: 'Auto-Identificação API',
        status: 'Interesse Inicial'
      });
    } else if (!client) {
      return res.status(403).json({ error: 'Por favor, identifique-se (nome e contacto) primeiro.' });
    }
    next();
  } catch (err) {
    logger.error('Erro no middleware ensureCustomer', err);
    res.status(500).json({ error: 'Erro ao validar identidade.' });
  }
}

function isPrivateOrLocalIp(ip) {
  const s = ip.replace(/^::ffff:/, '');
  if (s === '::1') return true;
  const parts = s.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function requireToken(req, res, next) {
  // Confiar em IPs privados/locais sem token (RFC1918 + loopback)
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (isPrivateOrLocalIp(ip)) return next();
  if (!API_TOKEN) return res.status(500).json({ error: 'API_TOKEN não configurado' });
  const t = req.headers['x-api-token'] || req.query.token;
  if (t !== API_TOKEN) return res.status(401).json({ error: 'não autorizado' });
  next();
}

function verifyWebhook(req, res, next) {
  if (!WEBHOOK_SECRET) {
    logger.error('WEBHOOK_SECRET não configurada — rejecting all webhook requests');
    return res.status(500).json({ error: 'configuração em falta' });
  }

  const { triggerEvent, payload, type } = req.body || {};
  logger.debug('Webhook verifyWebhook headers', { 
    triggerEvent, 
    type, 
    calSig: req.headers['cal-signature'],
    xCalSig: req.headers['x-cal-signature'],
    allHeaders: req.headers 
  });

  if (triggerEvent === 'PING' || type === 'PING') {
    logger.info('Webhook PING aceite sem verificação');
    return res.status(200).json({ status: 'ok', message: 'PONG' });
  }

  const signature = req.headers['x-cal-signature-256']
    || req.headers['cal-signature']
    || req.headers['x-cal-signature']
    || req.headers['x-hub-signature-256'];

  if (!signature) {
    logger.warn('Webhook sem assinatura', { ip: req.ip, path: req.path, triggerEvent });
    return res.status(401).json({ error: 'assinatura em falta' });
  }

  const body    = JSON.stringify(req.body);
  const hmacHex = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

  // Cal.eu envia o hex puro sem prefixo 'sha256=' — normalizar ambos os lados
  const rawSig  = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  try {
    if (rawSig.length !== hmacHex.length ||
        !crypto.timingSafeEqual(Buffer.from(rawSig), Buffer.from(hmacHex))) {
      logger.error('Webhook assinatura inválida', { ip: req.ip, triggerEvent });
      return res.status(401).json({ error: 'assinatura inválida' });
    }
  } catch (e) {
    logger.error('Webhook erro de verificação', { error: e.message });
    return res.status(401).json({ error: 'assinatura inválida' });
  }

  next();
}

const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'demasiadas tentativas, tente mais tarde' },
  standardHeaders: true, legacyHeaders: false,
});

const availabilityLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 60,
  message: { error: 'demasiadas tentativas, tente mais tarde' },
  standardHeaders: true, legacyHeaders: false,
});

const geoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  message: { error: 'demasiadas consultas geográficas, tente mais tarde' },
  standardHeaders: true, legacyHeaders: false,
});

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

// GET /availability?date=YYYY-MM-DD&duration=60&service=relaxamento&city=lisboa&domicilio=true
app.get('/availability', availabilityLimiter, async (req, res) => {
  let { date, duration = 60, service = 'relaxamento', city = 'lisboa', preferredTime, domicilio } = req.query;
  if (!date) return res.status(400).json({ error: 'date obrigatório (YYYY-MM-DD)' });

  const isDomicilio = domicilio === 'true' || domicilio === '1';

  // Normaliza data: 2026-4-9 → 2026-04-09
  date = date.replace(/(\d{4})-(\d{1,2})-(\d{1,2})/, (_, y, m, d) =>
    `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);

  let preferred = null;
  if (preferredTime) {
    const [h, m] = preferredTime.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m)) {
      preferred = new Date();
      preferred.setHours(h, m, 0, 0);
    }
  }

  try {
    const slug        = resolveSlug(service, Number(duration), isDomicilio, city);
    const afterBuffer = getAfterEventBuffer(slug);
    const all         = await getAvailableSlots(date, Number(duration), service, isDomicilio, city);
    const selected    = selectSlots(all, Number(duration), preferred, afterBuffer);
    res.json({
      date, service,
      duration: Number(duration),
      location: isDomicilio ? 'domicilio' : 'consultorio',
      slots:    selected.map(s => ({ time: s.time })),
      total:    all.length,
    });
  } catch (err) {
    logger.error('API /availability erro', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /context?q=pricing&target=cliente
app.get('/context', availabilityLimiter, (req, res) => {
  const { q, target = 'cliente' } = req.query;
  if (!q) return res.status(400).json({ error: 'query (q) obrigatória' });
  
  // Segurança: Só permitir target=dev se o API_TOKEN estiver presente (uso do Flux)
  const isDevRequest = target === 'dev';
  if (isDevRequest) {
    const t = req.headers['x-api-token'] || req.query.token;
    if (t !== API_TOKEN) return res.status(401).json({ error: 'target dev não autorizado' });
  }

  const context = getContext(q, target);
  res.json(context);
});

// POST /booking { date, time, duration, service, city, name, email, phone, nif, notes, domicilio, language }
app.post('/booking', bookingLimiter, requireToken, ensureCustomer, async (req, res) => {
  const { date, time, duration = 60, service = 'relaxamento', city = 'lisboa', name, email, phone, nif, notes, domicilio, language = 'pt', telegram_id } = req.body;
  if (!date || !time || !name) {
    return res.status(400).json({ error: 'date, time e name são obrigatórios' });
  }

  const isDomicilio = !!domicilio;

  try {
    const booking = await createBooking({
      duration:  Number(duration),
      startTime: toIsoLisbon(date, time),
      name, email, phone, nif, service, notes, isDomicilio, language, city,
    });

    const uid = booking?.id;
    res.json({ success: true, uid, confirmUrl: uid ? `https://cal.com/booking/${uid}` : null });

    // Notifica o Paulo (Bot B) sem bloquear a resposta
    notifyBooking(booking)
      .catch(err => logger.warn('Notificação booking falhou', err.message));

    // CRM — sincronizar com o contrato unificado
    syncBookingToKommo(booking, telegram_id, {
      source: 'Telegram',
      language: language || 'pt'
    }).catch(err => logger.warn('CRM booking falhou', err.message));
  } catch (err) {
    logger.error('API /booking erro', err);
    res.status(400).json({ error: err.message, field: err.field || null });
  }
});

// GET /client?email=...&phone=...&telegram_id=... — lookup de cliente recorrente
app.get('/client', availabilityLimiter, async (req, res) => {
  const { email, phone, telegram_id } = req.query;
  if (!email && !phone && !telegram_id) {
    return res.status(400).json({ error: 'email, phone ou telegram_id obrigatório' });
  }

  try {
    // Telegram ID tem precedência — mais fiável que email/phone
    if (telegram_id) {
      const kommoClient = await findClientByTelegramId(telegram_id);
      if (kommoClient) return res.json({ found: true, source: 'kommo', ...kommoClient });
    }

    // Fallback: lookup no Cal.eu por email/phone
    if (email || phone) {
      const calClient = await findClient({ email, phone });
      if (calClient) return res.json({ found: true, source: 'caleu', ...calClient });
    }

    res.json({ found: false });
  } catch (err) {
    logger.error('API /client erro', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /cancel { uid, reason }
app.post('/cancel', bookingLimiter, requireToken, async (req, res) => {
  const { uid, reason = '' } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid obrigatório' });

  try {
    const bookingData = await getBookingByUid(uid);
    const attendee    = bookingData?.attendees?.[0];

    await cancelBooking(uid, reason);
    res.json({ success: true, uid });

    // Notifica o Paulo
    notifyCancel(uid, {
      name:   attendee?.name,
      phone:  attendee?.phoneNumber,
      reason,
    }).catch(err => logger.warn('Notificação cancel falhou', err.message));

    // CRM — tratado pelo webhook BOOKING_CANCELLED (evita double-update)
  } catch (err) {
    logger.error('API /cancel erro', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /reschedule { uid, date, time, reason }
app.post('/reschedule', bookingLimiter, requireToken, async (req, res) => {
  const { uid, date, time, reason = 'reagendamento a pedido do cliente' } = req.body;
  if (!uid || !date || !time) return res.status(400).json({ error: 'uid, date e time obrigatórios' });

  try {
    const startTime = toIsoLisbon(date, time);

    // Cal.eu pode rejeitar o UID se já foi reagendado anteriormente.
    // Nesse caso devolve o UID actual no erro — retentar com esse UID.
    let effectiveUid = uid;
    let booking;
    try {
      booking = await rescheduleBooking(effectiveUid, startTime, reason);
    } catch (firstErr) {
      const suggested = firstErr?.response?.data?.error?.message?.match(/uid=([A-Za-z0-9_-]{10,})\./)?.[1];
      if (suggested && suggested !== effectiveUid) {
        logger.warn('UID desactualizado, a retentar com UID actual', { oldUid: effectiveUid, newUid: suggested });
        effectiveUid = suggested;
        booking = await rescheduleBooking(effectiveUid, startTime, reason);
      } else {
        throw firstErr;
      }
    }

    const oldBooking = await getBookingByUid(effectiveUid).catch(() => null);
    const oldStart   = oldBooking?.start;
    const attendee   = oldBooking?.attendees?.[0];
    const newUid     = booking?.uid;

    res.json({
      success: true,
      uid:        newUid,
      start:      booking?.start,
      confirmUrl: newUid ? `https://cal.com/booking/${newUid}` : undefined,
    });

    // Notifica o Paulo
    notifyReschedule(booking, oldStart)
      .catch(err => logger.warn('Notificação reschedule falhou', err.message));

    // CRM — tratado pelo webhook BOOKING_RESCHEDULED (evita double-update)
  } catch (err) {
    logger.error('API /reschedule erro', err.response?.data || err.message || err);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// GET /bookings?email=...&phone=... — reservas futuras de um cliente
app.get('/bookings', availabilityLimiter, async (req, res) => {
  const { email, phone } = req.query;
  if (!email && !phone) return res.status(400).json({ error: 'email ou phone obrigatório' });

  try {
    const bookings = await getBookingsByContact({ email, phone });
    res.json({
      bookings: bookings.map(b => ({
        uid:     b.uid,
        start:   b.start,
        service: b.eventType?.slug || '',
        status:  b.status,
      })),
    });
  } catch (err) {
    logger.error('API /bookings erro', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /bookings-by-date?date=YYYY-MM-DD — reservas de um dia (admin/Flux)
app.get('/bookings-by-date', requireToken, async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date obrigatório (YYYY-MM-DD)' });
  }
  try {
    const bookings = await getBookingsByDate(date);
    res.json({
      bookings: bookings.map(b => ({
        uid:     b.uid,
        start:   b.start,
        name:    b.attendees?.[0]?.name || '',
        service: b.eventType?.slug || '',
        status:  b.status,
      })),
    });
  } catch (err) {
    logger.error('API /bookings-by-date erro', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /distance?address=...
app.get('/distance', geoLimiter, async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'address obrigatório' });

  try {
    const result = await calculateDistanceFromProvider(address);
    if (result.error) return res.json({ available: false, error: result.error });
    const priceCheck = getDomicilioPrice(null, 60, result.distance);
    res.json({
      distance:      result.distance,
      clientAddress: result.clientAddress,
      available:     priceCheck.available,
      maxRadius:     ZONES.RADIUS_25KM,
      origin:        PROVIDER_LOCATION.address,
      ...(priceCheck.available ? { zone: priceCheck.zone } : { reason: priceCheck.reason }),
    });
  } catch (err) {
    logger.error('API /distance erro', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /domicilio-check?address=...&service=relaxamento&duration=90
app.get('/domicilio-check', geoLimiter, async (req, res) => {
  const { address, service = 'relaxamento', duration = 60 } = req.query;
  if (!address) return res.status(400).json({ error: 'address obrigatório' });

  try {
    const geo = await calculateDistanceFromProvider(address);
    if (geo.error) return res.json({ available: false, error: geo.error });
    const price = getDomicilioPrice(service, Number(duration), geo.distance);
    res.json({ address: geo.clientAddress, distance: geo.distance, service, duration: Number(duration), origin: PROVIDER_LOCATION.address, ...price });
  } catch (err) {
    logger.error('API /domicilio-check erro', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /whatsapp-ping?sender=...&name=... — notifica Paulo quando cliente WhatsApp inicia/retoma conversa
const whatsappSessions = new Map(); // sender → lastNotifiedAt (ms)
const PING_COOLDOWN_MS = 30 * 60 * 1000;

app.get('/whatsapp-ping', requireToken, async (req, res) => {
  const { sender, name } = req.query;
  if (!sender) return res.status(400).json({ error: 'sender obrigatório' });

  const now  = Date.now();
  const last = whatsappSessions.get(sender) || 0;

  if (now - last < PING_COOLDOWN_MS) {
    return res.json({ ok: true, notified: false });
  }

  whatsappSessions.set(sender, now);
  const phone = sender.replace(/@.*$/, '').replace(/^\+/, '');
  const waLabel = name ? `*${name}* (+${phone})` : `+${phone}`;
  await sendToAdmin([`📱 *WhatsApp* — [${waLabel}](https://wa.me/${phone}) está a falar com a ${BOT_NAME}`]);
  logger.info('whatsapp-ping', { sender, name });
  res.json({ ok: true, notified: true });
});

// GET /telegram-ping?sender=TELEGRAM_ID&name=NOME&username=USERNAME — notifica quando cliente Telegram inicia/retoma conversa
const telegramSessions = new Map();

app.get('/telegram-ping', requireToken, async (req, res) => {
  const { sender, name, username } = req.query;
  if (!sender) return res.status(400).json({ error: 'sender obrigatório' });

  const now  = Date.now();
  const last = telegramSessions.get(sender) || 0;

  if (now - last < PING_COOLDOWN_MS) {
    return res.json({ ok: true, notified: false });
  }

  telegramSessions.set(sender, now);
  const display = name || sender;
  const link    = username ? `[*${display}*](https://t.me/${username.replace(/^@/, '')})` : `*${display}* (ID: \`${sender}\`)`;
  await sendToAdmin([`✈️ *Telegram* — ${link} está a falar com a ${BOT_NAME}`]);
  logger.info('telegram-ping', { sender, name, username });
  res.json({ ok: true, notified: true });
});

// POST /notify-paulo { message } — Noa escala para o Paulo via Flux (Bot B → Telegram)
app.post('/notify-paulo', bookingLimiter, requireToken, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message obrigatório' });
  try {
    await sendToAdmin([`🔔 ${BOT_NAME}: ${message}`]);
    logger.info('notify-paulo enviado', { message });
    res.json({ ok: true });
  } catch (err) {
    logger.error('API /notify-paulo erro', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ALIASES GET PARA O AGENTE (web_fetch só suporta GET) ────────────────────
// Só acessíveis de localhost (IP check em requireToken já garante isto).

// GET /book?date=&time=&service=&duration=&city=&name=&phone=&email=&telegram_id=&notes=&domicilio=
app.get('/book', bookingLimiter, requireToken, ensureCustomer, async (req, res) => {
  const { date, time, duration = 60, service = 'relaxamento', city = 'lisboa', name, email, phone, nif, notes, domicilio, language = 'pt', telegram_id } = req.query;
  if (!date || !time || !name) {
    return res.status(400).json({ error: 'date, time e name são obrigatórios' });
  }
  const isDomicilio = !!domicilio && domicilio !== 'false' && domicilio !== '0';
  try {
    const booking = await createBooking({
      duration:  Number(duration),
      startTime: toIsoLisbon(date, time),
      name, email, phone, nif, service, notes, isDomicilio, language, city,
    });
    const uid = booking?.id;
    res.json({ success: true, uid, confirmUrl: uid ? `https://cal.com/booking/${uid}` : null });
    notifyBooking(booking).catch(err => logger.warn('Notificação booking falhou', err.message));
    syncBookingToKommo(booking, telegram_id, { source: 'Telegram', language: language || 'pt' })
      .catch(err => logger.warn('CRM booking falhou', err.message));
  } catch (err) {
    logger.error('API /book (GET alias) erro', err);
    res.status(400).json({ error: err.message, field: err.field || null });
  }
});

// GET /book-cancel?uid=&reason=
app.get('/book-cancel', bookingLimiter, requireToken, async (req, res) => {
  const { uid, reason = '' } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid obrigatório' });
  try {
    const bookingData = await getBookingByUid(uid);
    const attendee    = bookingData?.attendees?.[0];
    await cancelBooking(uid, reason);
    res.json({ success: true, uid });
    notifyCancel(uid, { name: attendee?.name, phone: attendee?.phoneNumber, reason })
      .catch(err => logger.warn('Notificação cancel falhou', err.message));
  } catch (err) {
    logger.error('API /book-cancel erro', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /book-reschedule?uid=&date=&time=&reason=
app.get('/book-reschedule', bookingLimiter, requireToken, async (req, res) => {
  const { uid, date, time, reason = 'reagendamento a pedido do cliente' } = req.query;
  if (!uid || !date || !time) return res.status(400).json({ error: 'uid, date e time obrigatórios' });
  try {
    const startTime = toIsoLisbon(date, time);
    let effectiveUid = uid;
    let booking;
    try {
      booking = await rescheduleBooking(effectiveUid, startTime, reason);
    } catch (firstErr) {
      const suggested = firstErr?.response?.data?.error?.message?.match(/uid=([A-Za-z0-9_-]{10,})\./)?.[1];
      if (suggested && suggested !== effectiveUid) {
        logger.warn('UID desactualizado, a retentar', { oldUid: effectiveUid, newUid: suggested });
        effectiveUid = suggested;
        booking = await rescheduleBooking(effectiveUid, startTime, reason);
      } else throw firstErr;
    }
    const oldBooking = await getBookingByUid(effectiveUid).catch(() => null);
    const oldStart   = oldBooking?.start;
    const newUid     = booking?.uid;
    res.json({ success: true, uid: newUid, start: booking?.start, confirmUrl: newUid ? `https://cal.com/booking/${newUid}` : undefined });
    notifyReschedule(booking, oldStart).catch(err => logger.warn('Notificação reschedule falhou', err.message));
  } catch (err) {
    logger.error('API /book-reschedule erro', err.response?.data || err.message || err);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// GET /alert?message=
app.get('/alert', bookingLimiter, requireToken, async (req, res) => {
  const { message } = req.query;
  if (!message) return res.status(400).json({ error: 'message obrigatório' });
  try {
    await sendToAdmin([`🔔 ${BOT_NAME}: ${message}`]);
    logger.info('alert enviado', { message });
    res.json({ ok: true });
  } catch (err) {
    logger.error('API /alert erro', err);
    res.status(500).json({ error: err.message });
  }
});

// OTP store em memória para dupla verificação de comandos destrutivos (Nexus admin bot)
const otpStore = new Map(); // requestId → { code, action, expiresAt, attempts }

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of otpStore)
    if (now > entry.expiresAt) otpStore.delete(id);
  for (const [id, ts] of whatsappSessions)
    if (now - ts > 2 * 3600 * 1000) whatsappSessions.delete(id);
  for (const [id, ts] of telegramSessions)
    if (now - ts > 2 * 3600 * 1000) telegramSessions.delete(id);
}, 3600 * 1000).unref();

// POST /admin/otp/generate — gera código OTP e envia ao João via bot de notificações
app.post('/admin/otp/generate', requireToken, (req, res) => {
  const { action } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });

  const requestId = crypto.randomBytes(8).toString('hex');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(requestId, { code, action, expiresAt: Date.now() + 5 * 60 * 1000, attempts: 3 });
  notifyOtp(action, code).catch(() => {});

  res.json({ requestId, expiresIn: 300 });
});

// POST /admin/otp/verify — verifica código OTP
app.post('/admin/otp/verify', requireToken, (req, res) => {
  const { requestId, code } = req.body;
  const entry = otpStore.get(requestId);

  if (!entry) return res.json({ valid: false, reason: 'not_found' });
  if (Date.now() > entry.expiresAt) { otpStore.delete(requestId); return res.json({ valid: false, reason: 'expired' }); }
  if (entry.attempts <= 0) { otpStore.delete(requestId); return res.json({ valid: false, reason: 'max_attempts' }); }

  entry.attempts--;
  if (entry.code !== String(code)) return res.json({ valid: false, reason: 'wrong_code' });

  otpStore.delete(requestId);
  res.json({ valid: true });
});

// POST /admin/refresh-event-types — força re-fetch do catálogo Cal.com
app.post('/admin/refresh-event-types', requireToken, async (req, res) => {
  try {
    await catalog.refresh();
    res.json({ ok: true, message: 'Catálogo actualizado', catalog: catalog.getCatalog() });
  } catch (err) {
    logger.error('API /admin/refresh-event-types erro', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/catalog — inspecção do catálogo de event types
app.get('/admin/catalog', requireToken, (req, res) => {
  res.json(catalog.getCatalog());
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─── BOT SEREN — WEBHOOK TELEGRAM ────────────────────────────────────────────

function verifyTelegramWebhook(req, res, next) {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!TELEGRAM_WEBHOOK_SECRET || secret !== TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  next();
}

app.post('/telegram/seren', verifyTelegramWebhook, (req, res) => {
  res.sendStatus(200); // responder à Telegram imediatamente
  const update = req.body;
  const msg    = update?.message || update?.edited_message;
  if (!msg?.text) return;
  serenHandleUpdate(msg.chat.id, msg.from, msg.text).catch(err =>
    logger.error('seren-handler erro', { err: err.message })
  );
});

// GET /admin/ab-stats — estatísticas A/B/C
app.get('/admin/ab-stats', requireToken, (req, res) => {
  res.json(getAbStats());
});

// POST /admin/responses/reload — hot reload do responses.json sem restart
app.post('/admin/responses/reload', requireToken, (req, res) => {
  try {
    reloadResponses();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK CAL.EU ───────────────────────────────────────────────────────────

app.post('/webhook/caleu', verifyWebhook, async (req, res) => {
  res.sendStatus(200);
  const { triggerEvent, payload } = req.body;
  logger.info('Webhook Cal.eu recebido', { triggerEvent, uid: payload?.uid });
  await handleCalEuWebhook(triggerEvent, payload);
});

app.listen(PORT, '127.0.0.1', () => {
  logger.info(`SerenBot API a correr na porta ${PORT}`);
  catalog.init().catch(err => logger.warn('calcom-catalog: init falhou', err.message));
});
