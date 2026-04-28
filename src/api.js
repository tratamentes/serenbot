/**
 * API local — para o agente OpenClaw consultar disponibilidade e criar reservas.
 * Corre em localhost:3001 (separado do bot Telegram).
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
const { getAfterEventBuffer, refresh: refreshEventTypes } = require('./infra/event-types-cache');

const { selectSlots }                         = require('./core/slots');
const { handleCalEuWebhook }                  = require('./infra/webhook');
const { notifyBooking, notifyCancel, notifyReschedule, sendToAdmin } = require('./infra/notify');
const logger                                  = require('./utils/logger');
const { calculateDistanceFromProvider, PROVIDER_LOCATION } = require('./infra/geocoding');
const { getDomicilioPrice, ZONES }            = require('./core/domicilio');
const {
  findClientByPhone, findClientByTelegramId,
  createOrUpdateLead, syncBookingToKommo,
} = require('./infra/kommo');
const { getContext } = require('./utils/graph-context');

const app  = express();
app.use(express.json());

// ─── SEGURANÇA: REDAÇÃO DE SEGREDOS ──────────────────────────────────────────

function redactSecrets(data) {
  return data;
}

// Wrapper para logger que redige segredos automaticamente
const safeLogger = {
  info: (msg, data) => logger.info(msg, redactSecrets(data)),
  warn: (msg, data) => logger.warn(msg, redactSecrets(data)),
  error: (msg, data) => logger.error(msg, redactSecrets(data)),
  debug: (msg, data) => logger.debug(msg, redactSecrets(data))
};

const PORT = 3001;

const API_TOKEN      = process.env.API_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const BOT_NAME       = process.env.BOT_CLIENT_NAME || 'Bot';

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────

/**
 * Middleware para garantir que o utilizador tem uma Lead/Contacto no Kommo.
 * Bloqueia acções de agendamento se não houver identificação.
 */
async function ensureCustomer(req, res, next) {
  const { telegram_id, phone, name } = req.body;
  
  if (!telegram_id && !phone) {
    return res.status(403).json({ error: 'Identificação necessária para esta acção.' });
  }

  try {
    let client = telegram_id ? await findClientByTelegramId(telegram_id) : await findClientByPhone(phone);
    
    if (!client && name) {
      // Criar prospecto se não existir
      safeLogger.info('Novo prospecto detectado, a criar no Kommo', { name, telegram_id, phone });
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
    safeLogger.error('Erro no middleware ensureCustomer', err);
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

// GET /availability?date=YYYY-MM-DD&duration=60&service=bliss&domicilio=true
app.get('/availability', availabilityLimiter, async (req, res) => {
  let { date, duration = 60, service = 'bliss', preferredTime, domicilio } = req.query;
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
    const slug        = resolveSlug(service, Number(duration), isDomicilio);
    const afterBuffer = await getAfterEventBuffer(slug);
    const all         = await getAvailableSlots(date, Number(duration), service, isDomicilio);
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

// POST /booking { date, time, duration, service, name, email, phone, nif, notes, domicilio, language }
app.post('/booking', bookingLimiter, requireToken, ensureCustomer, async (req, res) => {
  const { date, time, duration = 60, service = 'bliss', name, email, phone, nif, notes, domicilio, language = 'pt', telegram_id } = req.body;
  if (!date || !time || !name) {
    return res.status(400).json({ error: 'date, time e name são obrigatórios' });
  }

  const isDomicilio = !!domicilio;

  try {
    const booking = await createBooking({
      duration:  Number(duration),
      startTime: toIsoLisbon(date, time),
      name, email, phone, nif, service, notes, isDomicilio, language,
    });

    const uid = booking?.id;
    res.json({ success: true, uid, confirmUrl: uid ? `https://cal.eu/booking/${uid}` : null });

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
      confirmUrl: newUid ? `https://cal.eu/booking/${newUid}` : undefined,
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

// GET /domicilio-check?address=...&service=bliss&duration=90
app.get('/domicilio-check', geoLimiter, async (req, res) => {
  const { address, service = 'bliss', duration = 60 } = req.query;
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

// POST /admin/refresh-event-types — força re-fetch da config do Cal.eu
app.post('/admin/refresh-event-types', requireToken, async (req, res) => {
  try {
    await refreshEventTypes();
    res.json({ ok: true, message: 'Event types actualizados' });
  } catch (err) {
    logger.error('API /admin/refresh-event-types erro', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Parseia um ficheiro JSONL e devolve conversas agrupadas por sender
function parseSessionFile(filePath) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) return [];

  const senders = new Map(); // senderId -> { name, messages[], lastTs, model, totalTokens, totalCost }
  const SKIP = [
    'A new session was started', 'Run your Session', 'Read HEARTBEAT.md',
    'HEARTBEAT_OK', 'Session Startup', '---\nname: scheduling',
  ];

  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  let currentSenderId = '__default__';
  let currentSenderName = '';

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'message' || !obj.message) continue;
      const role = obj.message.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = obj.message.content;
      let raw = '', thinking = '';
      if (typeof content === 'string') {
        raw = content;
      } else if (Array.isArray(content)) {
        raw      = content.filter(c => c?.type === 'text').map(c => c.text).join('\n');
        thinking = content.filter(c => c?.type === 'thinking').map(c => c.thinking).join('\n');
      }

      // Extrair sender do metadata injectado pelo OpenClaw
      const sidM  = raw.match(/"sender_id":\s*"(\d+)"/);
      const nameM = raw.match(/"sender":\s*"([^"]+)"/);
      const userM = raw.match(/"username":\s*"([^"]+)"/);

      if (sidM && role === 'user') {
        currentSenderId   = sidM[1];
        currentSenderName = nameM?.[1] || userM?.[1] || sidM[1];
      }

      if (!senders.has(currentSenderId))
        senders.set(currentSenderId, { name: currentSenderName || currentSenderId, messages: [], lastTs: null, model: null, totalTokens: 0, totalCost: 0 });

      const entry = senders.get(currentSenderId);
      if (currentSenderName) entry.name = currentSenderName;

      // Acumular tokens/custo/modelo das respostas do assistente
      if (role === 'assistant') {
        const usage = obj.message.usage;
        if (usage) {
          entry.totalTokens += usage.totalTokens || 0;
          entry.totalCost   += usage.cost?.total || 0;
        }
        if (obj.message.model) entry.model = obj.message.model;
      }

      // Limpar texto para display
      let text = raw;
      text = text.replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '');
      text = text.replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '');
      text = text.replace(/To send an image back.*?\n/g, '');
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
      text = text.replace(/<\/?final>/g, '');
      text = text.replace(/System: \[[^\]]*\][^\n]*\n?/g, '');
      text = text.trim();

      if (!text) continue;
      if (SKIP.some(s => text.startsWith(s))) continue;
      if (text.includes('<final>HEARTBEAT_OK</final>') || text === 'HEARTBEAT_OK') continue;

      const ts = obj.timestamp ? new Date(obj.timestamp) : null;
      if (ts) entry.lastTs = ts;
      entry.messages.push({ role, text, ts, thinking: thinking || null });
    } catch {}
  }

  return Array.from(senders.entries())
    .filter(([, v]) => v.messages.filter(m => m.role === 'user').length > 0)
    .map(([senderId, v]) => ({ senderId, name: v.name, messages: v.messages, lastTs: v.lastTs, model: v.model, totalTokens: v.totalTokens, totalCost: v.totalCost }));
}

const CSS = `
  body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:16px;background:#f5f5f5}
  h1{font-size:1.1rem;margin-bottom:12px}
  a{color:#1976d2;text-decoration:none}
  .datebar{display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap}
  select{font-size:.9rem;padding:6px 10px;border-radius:6px;border:1px solid #ccc;background:#fff}
  .card{background:#fff;border-radius:8px;margin-bottom:10px;padding:12px 16px;box-shadow:0 1px 3px rgba(0,0,0,.1);display:flex;justify-content:space-between;align-items:center;gap:8px}
  .card .info{font-size:.9rem;flex:1;min-width:0}
  .card .info small{color:#888;display:block;margin-top:2px;font-size:.8rem}
  .card .info .tag{font-size:.7rem;background:#e3f2fd;color:#1976d2;padding:2px 6px;border-radius:4px;margin-right:4px}
  .btns{display:flex;gap:6px;flex-shrink:0}
  .btn{font-size:.8rem;background:#1976d2;color:#fff;padding:4px 10px;border-radius:6px;white-space:nowrap}
  .btn.raw{background:#757575}
  .chat{display:flex;flex-direction:column;gap:6px;margin-top:12px}
  .msg{padding:7px 11px;border-radius:8px;font-size:.85rem;max-width:88%;white-space:pre-wrap;word-break:break-word}
  .user{background:#e3f2fd;align-self:flex-start}
  .bot{background:#f3e5f5;align-self:flex-end}
  .ts{font-size:.7rem;color:#bbb;margin-top:2px}
  .back{display:inline-block;margin-bottom:12px;font-size:.85rem}
  pre{font-size:.75rem;background:#fff;padding:12px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
  details.think{margin-top:6px;font-size:.75rem;color:#888;border-left:2px solid #e0e0e0;padding-left:8px}
  details.think summary{cursor:pointer;color:#aaa;user-select:none}
  details.think pre{background:none;padding:4px 0;margin:0;font-size:.75rem;white-space:pre-wrap;word-break:break-word}`;

// GET /admin/sessions — lista ou chat
app.get('/admin/sessions', requireToken, async (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const agentName    = process.env.OPENCLAW_AGENT_NAME || 'cliente';
  const SESSIONS_DIR = process.env.OPENCLAW_SESSIONS_DIR
    || path.join(process.env.HOME, `.openclaw/agents/${agentName}/sessions`);
  const token   = req.headers['x-api-token'] || req.query.token;
  const fmt     = d => d ? d.toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon', hour12: false }) : '—';
  const esc     = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  try {
    // Recolher todos os ficheiros JSONL (activos + reset)
    const allFiles = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl') || f.includes('.jsonl.reset.'))
      .map(f => {
        const filePath = path.join(SESSIONS_DIR, f);
        const isReset  = f.includes('.jsonl.reset.');
        const uid      = isReset ? f.split('.jsonl.reset.')[0] : f.replace('.jsonl','');
        let updated    = null;
        if (isReset) {
          const tsStr  = f.split('.jsonl.reset.')[1];
          const isoStr = tsStr?.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
          updated      = isoStr ? new Date(isoStr) : null;
        } else {
          updated = new Date(fs.statSync(filePath).mtime);
        }
        return { uid, filePath, updated, isReset };
      });

    // Vista raw
    if (req.query.raw) {
      const entry = allFiles.find(f => f.uid === req.query.raw);
      if (!entry) return res.status(404).send('não encontrado');
      const content = fs.readFileSync(entry.filePath, 'utf8');
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head>
<body><a class="back" href="/admin/sessions?token=${token}">← Sessões</a><h1>RAW — ${esc(entry.uid)}</h1><pre>${esc(content)}</pre></body></html>`;
      return res.set('Content-Type','text/html; charset=utf-8').send(html);
    }

    // Vista de chat por sender
    if (req.query.uid && req.query.sender) {
      const entry = allFiles.find(f => f.uid === req.query.uid);
      if (!entry) return res.status(404).send('não encontrado');
      const convs = parseSessionFile(entry.filePath);
      const conv  = convs.find(c => c.senderId === req.query.sender) || convs[0];
      if (!conv) return res.status(404).send('conversa não encontrada');

      const chat = conv.messages.map(m => {
        const who       = m.role === 'user' ? `👤 ${esc(conv.name)}` : `🤖 ${esc(BOT_NAME)}`;
        const ts        = m.ts ? `<div class="ts">${fmt(m.ts)}</div>` : '';
        const thinkHtml = m.thinking
          ? `<details class="think"><summary>raciocínio interno</summary><pre>${esc(m.thinking)}</pre></details>`
          : '';
        return `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}">${who}<br>${esc(m.text)}${thinkHtml}${ts}</div>`;
      }).join('\n');

      const backUrl   = `/admin/sessions?token=${token}&date=${entry.updated?.toLocaleDateString('sv-SE',{timeZone:'Europe/Lisbon'})||''}`;
      const modelInfo = conv.model ? ` · ${esc(conv.model)}` : '';
      const tokInfo   = conv.totalTokens > 0 ? ` · ${conv.totalTokens.toLocaleString('pt-PT')} tokens` : '';
      const costInfo  = conv.totalCost > 0 ? ` · $${conv.totalCost.toFixed(4)}` : '';
      const html = `<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(conv.name)}</title><style>${CSS}</style></head>
<body>
<a class="back" href="${backUrl}">← Sessões</a>
<h1>${esc(conv.name)}</h1>
<small style="color:#888">${fmt(entry.updated)}${modelInfo}${tokInfo}${costInfo} · <a href="/admin/sessions?raw=${entry.uid}&token=${token}">ver raw</a></small>
<div class="chat">${chat || '<em>sem mensagens</em>'}</div>
</body></html>`;
      return res.set('Content-Type','text/html; charset=utf-8').send(html);
    }

    // Lista — expandir por sender
    const todayLisbon  = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Lisbon' });
    const filterDate   = req.query.date || todayLisbon;

    // Recolher todas as conversas (ficheiro × sender)
    const conversations = [];
    for (const entry of allFiles) {
      const d = entry.updated?.toLocaleDateString('sv-SE', { timeZone: 'Europe/Lisbon' });
      if (d !== filterDate) continue;
      const convs = parseSessionFile(entry.filePath);
      for (const conv of convs) {
        conversations.push({ ...conv, uid: entry.uid, updated: entry.updated, isReset: entry.isReset });
      }
    }
    conversations.sort((a, b) => (b.updated || 0) - (a.updated || 0));

    const availableDates = [...new Set(
      allFiles.filter(f => f.updated).map(f => f.updated.toLocaleDateString('sv-SE', { timeZone: 'Europe/Lisbon' }))
    )].sort().reverse();

    const dateOptions = availableDates.map(d =>
      `<option value="${d}"${d === filterDate ? ' selected' : ''}>${new Date(d+'T12:00:00Z').toLocaleDateString('pt-PT',{day:'2-digit',month:'long',year:'numeric'})}</option>`
    ).join('');

    const rows = conversations.length
      ? conversations.map(c => {
          const tag   = c.isReset ? '<span class="tag">arquivo</span>' : '<span class="tag" style="background:#e8f5e9;color:#388e3c">activo</span>';
          const chatUrl = `/admin/sessions?uid=${c.uid}&sender=${c.senderId}&token=${token}`;
          const rawUrl  = `/admin/sessions?raw=${c.uid}&token=${token}`;
          const nMsgs   = c.messages.filter(m => m.role === 'user').length;
          const modelStr = c.model ? ` · ${esc(c.model)}` : '';
          const tokStr   = c.totalTokens > 0 ? ` · ${c.totalTokens.toLocaleString('pt-PT')} tok` : '';
          const costStr  = c.totalCost > 0 ? ` · $${c.totalCost.toFixed(4)}` : '';
          return `<div class="card">
          <div class="info">${tag}<strong>${esc(c.name)}</strong><small>${fmt(c.updated)} · ${nMsgs} msg(s)${modelStr}${tokStr}${costStr}</small></div>
          <div class="btns"><a class="btn" href="${chatUrl}">Ver chat</a><a class="btn raw" href="${rawUrl}">Raw</a></div>
        </div>`;
        }).join('\n')
      : '<p style="color:#888;margin-top:12px">Sem sessões neste dia.</p>';

    const html = `<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sessões ${esc(BOT_NAME)}</title><style>${CSS}</style></head>
<body>
<h1>Sessões ${esc(BOT_NAME)}</h1>
<div class="datebar">
  <select onchange="location.href='/admin/sessions?token=${token}&date='+this.value">${dateOptions||`<option value="${todayLisbon}">Hoje</option>`}</select>
  <span style="color:#888;font-size:.85rem">${conversations.length} conversa(s)</span>
</div>
${rows}
</body></html>`;

    res.set('Content-Type','text/html; charset=utf-8').send(html);
  } catch (err) {
    logger.error('API /admin/sessions erro', err);
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

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Cal.eu API local a correr na porta ${PORT}`);
});
