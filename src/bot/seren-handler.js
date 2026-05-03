const { createClient } = require('../utils/http');
const { normalizePhone } = require('../utils/phone');
const { utcToLisbon } = require('../utils/time');
const { classifyIntent, classifySource } = require('./intent');
const { getSession } = require('./session');
const { pickVariant, fillTemplate, recordContinued } = require('./ab-responses');
const { llmFallback } = require('./llm-fallback');
const { scheduleFollowUps, cancelFollowUps } = require('./followup');

const http     = createClient('https://api.telegram.org');
const CAL_BASE = 'https://cal.com/joao-goulart-tratamentes-lisboa-cascais';
const sources  = require('../../data/sources.json');

const PORT     = process.env.API_PORT || '3002';
const localApi = createClient(`http://127.0.0.1:${PORT}`);

// ── UTILIDADES ────────────────────────────────────────────────────────────────

async function send(chatId, text) {
  const token = process.env.TELEGRAM_TOKEN_AGENT1;
  await http.post(`/bot${token}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'Markdown',
  }).catch(() => {});
}

function detectCity(text) {
  const s = text.toLowerCase();
  if (s.includes('cascais')) return 'cascais';
  if (s.includes('domicil')) return 'domicilio';
  if (s.includes('lisboa') || s.includes('alvalade')) return 'lisboa';
  return null;
}

function detectDurationByIndex(text, sourceKey) {
  const durations = sources[sourceKey]?.durations || [];
  const trimmed = text.trim();
  const idx = parseInt(trimmed, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= durations.length) return durations[idx - 1].min;
  const s = text.toLowerCase();
  if (s.includes('30') || s.includes('meia hora') || s.includes('express')) return 30;
  if (s.includes('90') || s.includes('hora e meia')) return 90;
  if (s.includes('60') || s.includes('uma hora') || s.includes('1 hora') || s.includes('1h')) return 60;
  return null;
}

function durationOptions(sourceKey) {
  return (sources[sourceKey]?.durations || []).map((d, i) => {
    const nota = d.note ? ` _(${d.note})_` : '';
    return `${i + 1}️⃣ ${d.label}${nota}`;
  }).join('\n');
}

function resolveSlug(sourceKey, city, durationMin) {
  const src = sources[sourceKey];
  if (!src) return null;
  const d = (src.durations || []).find(x => x.min === durationMin) || src.durations?.[0];
  if (!d) return null;
  if (city === 'cascais')   return d.slugCascais || null;
  if (city === 'domicilio') return d.slugDomicilio || null;
  return d.slugLisboa || null;
}

function cityLabel(city) {
  if (city === 'cascais')   return 'Cascais — Clínica Now';
  if (city === 'domicilio') return 'Domicílio';
  return 'Lisboa — Alvalade';
}

function formatDate(isoDate) {
  return new Date(isoDate + 'T12:00:00').toLocaleDateString('pt-PT', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Lisbon',
  });
}

// ── API INTERNA (localhost) ───────────────────────────────────────────────────

async function lookupBookings(phone, email) {
  try {
    const params = {};
    if (phone) params.phone = phone;
    if (email) params.email = email;
    const { data } = await localApi.get('/bookings', { params });
    const all = Array.isArray(data) ? data : (data?.bookings || []);
    return all.filter(b => b.start && new Date(b.start).getTime() > Date.now());
  } catch { return []; }
}

async function lookupClient(telegramId, phone) {
  try {
    const params = {};
    if (telegramId) params.telegram_id = telegramId;
    else if (phone) params.phone = phone;
    const { data } = await localApi.get('/client', { params });
    return data;
  } catch { return { found: false }; }
}


async function fetchAvailability(date, sourceKey, city, durationMin) {
  try {
    const slug = resolveSlug(sourceKey, city, durationMin);
    if (!slug) return [];
    const { data } = await localApi.get('/availability', {
      params: { date, duration: durationMin, service: sourceKey, city: city === 'domicilio' ? 'lisboa' : city, domicilio: city === 'domicilio' ? '1' : undefined },
    });
    // Converter ISO → { date, time } no fuso de Lisboa para o booking + display
    return (data?.slots || []).map(s => {
      const lx = utcToLisbon(s.time);
      return { date: lx.date, time: lx.time, display: lx.time };
    });
  } catch { return []; }
}

async function createBookingInternal({ date, time, name, email, phone, duration, sourceKey, city, telegramId }) {
  const src = sources[sourceKey];
  const isDomicilio = city === 'domicilio';
  const { data } = await localApi.post('/booking', {
    date, time, duration, name,
    email:       email || undefined,
    phone:       phone || undefined,
    service:     sourceKey,
    city:        isDomicilio ? 'lisboa' : city,
    domicilio:   isDomicilio || undefined,
    notes:       src?.bookingNote || undefined,
    telegram_id: String(telegramId),
    language:    'pt',
  });
  return data;
}

// ── SELECÇÃO DE DATAS ─────────────────────────────────────────────────────────

async function findAvailableDates(session) {
  const today = new Date();
  const candidates = [];
  for (let i = 0; i <= 9; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    candidates.push(d.toISOString().slice(0, 10));
  }
  const results = await Promise.all(
    candidates.map(async date => ({ date, slots: await fetchAvailability(date, session.source, session.city, session.duration) }))
  );
  return results.filter(r => r.slots.length > 0).slice(0, 4);
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────────

async function handleUpdate(chatId, from, text) {
  const session = getSession(chatId);
  const isFirstMessage = session.state === 'NEW';

  session.name      = session.name || from?.first_name || '';
  session.telegramId = session.telegramId || from?.id;

  for (const [key, vid] of Object.entries(session.lastVariants || {})) recordContinued(key, vid);
  session.lastVariants = {};
  cancelFollowUps(chatId);

  // Notifica admin na primeira mensagem de cada sessão (cooldown 30min em api.js)
  if (isFirstMessage) {
    localApi.get('/telegram-ping', { params: {
      sender:   String(chatId),
      name:     from?.first_name || '',
      username: from?.username || '',
    }}).catch(() => {});
  }

  const vars = { nome: session.name };

  // ── DEEP LINK ─────────────────────────────────────────────────────────────
  const startMatch = text.match(/^\/start(?:\s+(\S+))?$/i);
  if (startMatch) {
    const param = startMatch[1];
    if (param && sources[param]) {
      session.source       = param;
      session.state        = 'QUALIFIED';
      session.lastQuestion = 'booking';
      const reply = pickVariant(`greeting_${param}`, session) || pickVariant('greeting_generic', session);
      await send(chatId, fillTemplate(reply, vars));
      scheduleFollowUps(chatId, session.name, sources[param].painDesire);
    } else {
      session.state = 'QUALIFYING';
      await send(chatId, fillTemplate(pickVariant('qualifying_question', session), vars));
      scheduleFollowUps(chatId, session.name, null);
    }
    return;
  }

  const intent = classifyIntent(text);

  // ── CONTEÚDO INAPROPRIADO — responde sempre, independentemente do estado ──
  if (intent === 'inappropriate') {
    await send(chatId, fillTemplate(pickVariant('inappropriate', session), vars));
    return;
  }

  // ── INTENTS TRANSVERSAIS — respondem independentemente do estado ──────────
  // (cancel, location, hours: o utilizador pode perguntar a qualquer momento)
  if (session.state !== 'CONFIRMING_BOOKING') {
    if (intent === 'cancel') {
      await send(chatId, fillTemplate(pickVariant('cancel_info', session), vars));
      session.state = 'CANCEL_LOOKUP';
      return;
    }
    if (intent === 'location' && session.state !== 'AWAITING_LOCATION') {
      await send(chatId, fillTemplate(pickVariant('location_info', session), vars));
      return;
    }
    if (intent === 'hours') {
      await send(chatId, fillTemplate(pickVariant('hours_info', session), vars));
      return;
    }
  }

  // ── CANCEL_LOOKUP — aguarda telefone, verifica attendee, mostra só a reserva certa ──
  if (session.state === 'CANCEL_LOOKUP') {
    const phone = normalizePhone(text.trim());
    if (!phone || phone.length < 9) {
      await send(chatId, 'Qual é o teu número de telemóvel? (ex: 912 345 678)');
      return;
    }
    // Tentar obter email do Kommo para melhorar o lookup (bookings por vezes só têm email)
    let email;
    try {
      const c = await lookupClient(null, phone);
      if (c?.found && c.email) email = c.email;
    } catch {}
    const bookings = await lookupBookings(phone, email);
    if (!bookings.length) {
      await send(chatId, 'Não encontrei reservas futuras para esse número. Podes encontrar o link de cancelamento no email de confirmação que recebeste quando marcaste.');
      session.state = 'QUALIFIED';
      return;
    }
    bookings.sort((a, b) => new Date(a.start) - new Date(b.start));
    const next = bookings[0];
    const dt   = next.start ? utcToLisbon(next.start) : null;
    const quando = dt ? `${formatDate(dt.date)} às ${dt.time}` : '—';
    const extra  = bookings.length > 1
      ? `\n_(tens mais ${bookings.length - 1} reserva${bookings.length > 2 ? 's' : ''} — diz-me se é outra)_`
      : '';
    await send(chatId, `A tua próxima reserva é:\n\n*${quando}*\n\n🔗 https://cal.com/booking/${next.uid}?cancel=true\n\nUsa o link para cancelar ou reagendar.${extra}`);
    session.state = 'QUALIFIED';
    return;
  }

  // ── BOOKED — após reserva, retomar contexto normal ────────────────────────
  if (session.state === 'BOOKED') {
    session.state = 'QUALIFIED';
    // cai para o routing de intent abaixo
  }


  // ── QUALIFICAÇÃO ──────────────────────────────────────────────────────────
  if (session.state === 'NEW' || session.state === 'QUALIFYING') {
    // Opção 5 = "Outra razão" — avança para genérico
    const isOther = text.trim() === '5'
      || /^outr[ao]/i.test(text.trim())
      || /\boutr[ao]\b/i.test(text);
    if (isOther) {
      session.source = null;
      session.state  = 'QUALIFIED';
      await send(chatId, fillTemplate(pickVariant('greeting_generic', session), vars));
      scheduleFollowUps(chatId, session.name, null);
      return;
    }
    const src = classifySource(text);
    if (src) {
      session.source       = src;
      session.state        = 'QUALIFIED';
      session.lastQuestion = 'booking';
      const reply = pickVariant(`greeting_${src}`, session) || pickVariant('greeting_generic', session);
      await send(chatId, fillTemplate(reply, vars));
      scheduleFollowUps(chatId, session.name, sources[src]?.painDesire || null);
      return;
    }
    if (session.state === 'NEW') {
      // Se o intent é conhecido (saudação, preço, serviços, booking) — responde
      // directamente e passa para QUALIFYING; não interrompe com o menu.
      // Só mostra o menu de qualificação se a mensagem for genuinamente opaca.
      if (intent === 'unknown') {
        session.state = 'QUALIFYING';
        await send(chatId, fillTemplate(pickVariant('qualifying_question', session), vars));
        scheduleFollowUps(chatId, session.name, null);
        return;
      }
      session.state = 'QUALIFYING'; // actualiza estado mas cai para os handlers abaixo
    }
    // QUALIFYING sem source match e intent conhecido — cai para handlers de intent
    if (intent === 'unknown') {
      await send(chatId, 'Desculpa, não percebi bem 😊 Podes escolher uma das opções (1 a 5) ou descrever o que procuras?');
      return;
    }
  }

  // ── AWAITING_LOCATION ─────────────────────────────────────────────────────
  if (session.state === 'AWAITING_LOCATION') {
    const city = detectCity(text);
    if (!city) { await send(chatId, fillTemplate(pickVariant('ask_location', session), vars)); return; }
    session.city = city;
    const src = sources[session.source];
    if (!src?.durations || src.durations.length === 1) {
      session.duration = src?.durations?.[0]?.min || 60;
      session.state    = 'COLLECTING_PHONE';
      await send(chatId, fillTemplate(pickVariant('ask_phone', session), vars));
    } else {
      session.state = 'AWAITING_DURATION';
      await send(chatId, fillTemplate(pickVariant('ask_duration', session), { ...vars, opcoes: durationOptions(session.source) }));
    }
    return;
  }

  // ── AWAITING_DURATION ─────────────────────────────────────────────────────
  if (session.state === 'AWAITING_DURATION') {
    const min = detectDurationByIndex(text, session.source);
    if (!min) { await send(chatId, `Podes escolher um número?\n\n${durationOptions(session.source)}`); return; }
    session.duration = min;
    session.state    = 'COLLECTING_PHONE';
    await send(chatId, fillTemplate(pickVariant('ask_phone', session), vars));
    return;
  }

  // ── COLLECTING_PHONE ──────────────────────────────────────────────────────
  if (session.state === 'COLLECTING_PHONE') {
    const phone = normalizePhone(text.trim());
    if (!phone || phone.length < 9) {
      await send(chatId, fillTemplate(pickVariant('invalid_phone', session), vars));
      return;
    }
    session.phone = phone;

    const client = await lookupClient(session.telegramId, phone);
    if (client?.found && client.name) {
      session.name     = client.name;
      session.email    = client.email || null;
      session.state    = 'CONFIRMING_CONTACT';
      session.lastQuestion = 'confirm_contact';
      await send(chatId, fillTemplate(pickVariant('confirm_contact', session), {
        ...vars, nome: client.name, email: client.email || 'sem email registado',
      }));
    } else {
      session.state = 'COLLECTING_NAME';
      await send(chatId, fillTemplate(pickVariant('ask_name', session), vars));
    }
    return;
  }

  // ── CONFIRMING_CONTACT ────────────────────────────────────────────────────
  if (session.state === 'CONFIRMING_CONTACT') {
    if (intent === 'affirmative' || isYes(text)) {
      await startDateSelection(chatId, session);
    } else {
      // Quer corrigir — recolhe nome novamente
      session.state = 'COLLECTING_NAME';
      await send(chatId, fillTemplate(pickVariant('ask_name', session), vars));
    }
    return;
  }

  // ── COLLECTING_NAME ───────────────────────────────────────────────────────
  if (session.state === 'COLLECTING_NAME') {
    if (text.trim().length < 2) { await send(chatId, 'Precisas de indicar um nome válido 😊'); return; }
    session.name  = text.trim();
    session.state = 'COLLECTING_EMAIL';
    await send(chatId, fillTemplate(pickVariant('ask_email', session), vars));
    return;
  }

  // ── COLLECTING_EMAIL ──────────────────────────────────────────────────────
  if (session.state === 'COLLECTING_EMAIL') {
    const skip = /sem email|nao|não|saltar|skip/i.test(text);
    session.email = skip ? null : (text.includes('@') ? text.trim() : null);
    if (!skip && !session.email) {
      await send(chatId, 'Esse email não parece válido. Podes indicar um email correcto ou dizer «sem email».');
      return;
    }
    await startDateSelection(chatId, session);
    return;
  }

  // ── SELECTING_DATE ────────────────────────────────────────────────────────
  if (session.state === 'SELECTING_DATE') {
    const dates = session.availableDates || [];
    const idx = parseInt(text.trim(), 10);
    if (!isNaN(idx) && idx >= 1 && idx <= dates.length) {
      session.selectedDate  = dates[idx - 1].date;
      session.selectedSlots = dates[idx - 1].slots.map(s => ({ ...s, date: s.date || dates[idx-1].date }));
      session.state         = 'SELECTING_TIME';
      await sendTimeOptions(chatId, session);
    } else {
      await sendDateOptions(chatId, session);
    }
    return;
  }

  // ── SELECTING_TIME ────────────────────────────────────────────────────────
  if (session.state === 'SELECTING_TIME') {
    const slots = session.selectedSlots || [];
    const idx = parseInt(text.trim(), 10);
    let time = null;
    if (!isNaN(idx) && idx >= 1 && idx <= slots.length) {
      time = slots[idx - 1].time;
    } else if (/^\d{1,2}:\d{2}$/.test(text.trim())) {
      time = text.trim();
    }
    if (!time) { await sendTimeOptions(chatId, session); return; }
    // Guardar o slot completo para ter date+time correctos para o booking
    const selectedSlot = !isNaN(idx) ? slots[idx - 1] : slots.find(s => s.time === text.trim()) || slots[0];
    session.selectedTime = selectedSlot?.time || time;
    session.selectedDate = selectedSlot?.date || session.selectedDate;
    session.state        = 'CONFIRMING_BOOKING';
    session.lastQuestion = 'confirm_booking';
    const src   = sources[session.source];
    const dur   = (src?.durations || []).find(d => d.min === session.duration);
    await send(chatId, fillTemplate(pickVariant('confirm_booking', session), {
      nome:    session.name,
      servico: src?.label || session.source,
      duracao: session.duration,
      data:    formatDate(session.selectedDate),
      hora:    session.selectedTime,
      local:   cityLabel(session.city),
      preco:   dur?.label?.split(' — ')[1] || '—',
    }));
    return;
  }

  // ── CONFIRMING_BOOKING ────────────────────────────────────────────────────
  if (session.state === 'CONFIRMING_BOOKING') {
    if (intent === 'affirmative' || isYes(text)) {
      await doBooking(chatId, session);
    } else {
      session.state = 'SELECTING_DATE';
      await send(chatId, 'Tudo bem, recomeçamos. ' + fillTemplate(pickVariant('ask_date', session), {
        opcoes: formatDateOptions(session.availableDates || []),
      }));
    }
    return;
  }

  // ── ESTADO QUALIFIED — intent normal ─────────────────────────────────────

  // Recusa explícita após uma pergunta de booking → não avançar para localização
  if (isNo(text) && session.lastQuestion === 'booking') {
    session.lastQuestion = null;
    await send(chatId, 'Sem problema! Posso ajudar com outra coisa? 😊');
    return;
  }

  const wantsBooking = intent === 'booking'
    || (intent === 'affirmative' && session.lastQuestion === 'booking')
    || (intent === 'unknown' && session.lastQuestion === 'booking' && text.trim().length < 20);

  if (wantsBooking) {
    const city = detectCity(text);
    if (city) {
      session.city  = city;
      const src = sources[session.source];
      if (!src?.durations || src.durations.length === 1) {
        session.duration = src?.durations?.[0]?.min || 60;
        session.state    = 'COLLECTING_PHONE';
        await send(chatId, fillTemplate(pickVariant('ask_phone', session), vars));
      } else {
        session.state = 'AWAITING_DURATION';
        await send(chatId, fillTemplate(pickVariant('ask_duration', session), { ...vars, opcoes: durationOptions(session.source) }));
      }
    } else {
      session.state = 'AWAITING_LOCATION';
      await send(chatId, fillTemplate(pickVariant('ask_location', session), vars));
    }
    return;
  }

  if (intent === 'services') {
    const detectedSrc = classifySource(text) || session.source;
    const infoKey = detectedSrc ? `service_info_${detectedSrc}` : 'service_info_generic';
    if (detectedSrc) session.source = detectedSrc;
    const reply   = pickVariant(infoKey, session) || pickVariant('service_info_generic', session);
    session.lastQuestion = 'booking';
    await send(chatId, fillTemplate(reply, vars));
    return;
  }

  if (intent === 'pricing') {
    const src = session.source ? sources[session.source] : null;
    const opts = src?.durations?.map(d => `• ${d.label}${d.note ? ` _(${d.note})_` : ''}`).join('\n') || 'a partir de 35€';
    const reply = pickVariant('pricing', session);
    session.lastQuestion = 'booking';
    await send(chatId, fillTemplate(reply, { ...vars, servico: src?.label || 'sessão', preco: `\n${opts}` }));
    return;
  }

  if (intent === 'greeting') {
    const greetKey = session.source ? `greeting_${session.source}` : 'greeting_generic';
    if (session.source) session.lastQuestion = 'booking';
    await send(chatId, fillTemplate(pickVariant(greetKey, session) || pickVariant('greeting_generic', session), vars));
    return;
  }

  // Afirmativo sem contexto — redirecionar para o ponto de entrada adequado
  if (intent === 'affirmative') {
    const greetKey = session.source ? `greeting_${session.source}` : 'greeting_generic';
    await send(chatId, fillTemplate(pickVariant(greetKey, session) || pickVariant('greeting_generic', session), vars));
    return;
  }

  // Fallback LLM
  const reply = await llmFallback(text);
  await send(chatId, reply);
}

// ── HELPERS DE FLUXO ─────────────────────────────────────────────────────────

function isYes(text) {
  return /^(sim|s|yes|y|ok|boa|vamos|confirmo|confirmar|certo|bora|quero|exato|exacto|perfeito|ótimo|otimo)$/i.test(text.trim());
}

function isNo(text) {
  const t = text.trim().toLowerCase();
  return /^(nao|não|no|nope|nunca|negativo|nem pensar)$/.test(t)
    || /^(nao obrigad|não obrigad)/.test(t);
}

async function startDateSelection(chatId, session) {
  session.state = 'SELECTING_DATE';
  await send(chatId, 'A verificar disponibilidade… ⏳');
  const dates = await findAvailableDates(session);
  if (!dates.length) {
    session.state = 'QUALIFIED';
    await send(chatId, fillTemplate(pickVariant('no_slots', session), { nome: session.name }));
    return;
  }
  session.availableDates = dates;
  await sendDateOptions(chatId, session);
}

function formatDateOptions(dates) {
  return dates.map((d, i) => `${i + 1}️⃣ ${formatDate(d.date)} (${d.slots.length} horários)`).join('\n');
}

async function sendDateOptions(chatId, session) {
  const opts  = formatDateOptions(session.availableDates || []);
  const reply = pickVariant('ask_date', session);
  await send(chatId, fillTemplate(reply, { nome: session.name, opcoes: opts }));
}

async function sendTimeOptions(chatId, session) {
  const slots = session.selectedSlots || [];
  const opts  = slots.map((s, i) => `${i + 1}️⃣ ${s.display || s.time}`).join('   ');
  const reply = pickVariant('ask_time', session);
  await send(chatId, fillTemplate(reply, { nome: session.name, data: formatDate(session.selectedDate), opcoes: opts }));
}

async function doBooking(chatId, session) {
  try {
    const result = await createBookingInternal({
      date:      session.selectedDate,
      time:      session.selectedTime,
      name:      session.name,
      email:     session.email,
      phone:     session.phone,
      duration:  session.duration,
      sourceKey: session.source,
      city:      session.city,
      telegramId: session.telegramId,
    });
    session.state = 'BOOKED';
    const link = result?.confirmUrl || result?.uid
      ? `https://cal.com/booking/${result.uid}`
      : null;
    await send(chatId, fillTemplate(pickVariant('booking_success', session), {
      nome: session.name,
      data: formatDate(session.selectedDate),
      link: link || CAL_BASE,
    }));
    cancelFollowUps(chatId);
  } catch (err) {
    await send(chatId, fillTemplate(pickVariant('booking_error', session), { nome: session.name }));
    session.state = 'QUALIFIED';
  }
}

module.exports = { handleUpdate };
