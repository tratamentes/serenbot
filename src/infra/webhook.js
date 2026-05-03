const logger = require('../utils/logger');
const { findLeadByBookingUid, moveLeadToStage, createOrUpdateLead, updateLeadFields, formatLeadName, FIELD, ENUM } = require('./kommo');
const { getBookingByUid } = require('./calcom');
const { utcToLisbon } = require('../utils/time');

// Nota: notificações de reschedule e cancel NÃO são enviadas aqui.
// Quando a operação vem da API (/reschedule, /cancel), a api.js já notifica o Paulo.
// O webhook apenas actualiza o Kommo — evita duplicação de mensagens.
// Para BOOKING_CREATED directo no Cal.eu (sem passar pela API), o Paulo não é notificado;
// se isso for necessário no futuro, adicionar notifyBooking aqui com dedup por UID.

async function handleCalEuWebhook(triggerEvent, payload) {
  const { uid, startTime, rescheduleUid, rescheduleStartTime } = payload || {};

  try {
    switch (triggerEvent) {
      case 'BOOKING_RESCHEDULED':
        await handleReschedule(uid, rescheduleUid, startTime, payload);
        break;
      case 'BOOKING_CANCELLED':
        await handleCancellation(uid, payload);
        break;
      case 'BOOKING_CREATED':
        await handleCreated(uid, startTime, payload);
        break;
      default:
        logger.debug('Webhook Cal.eu ignorado', { triggerEvent });
    }
  } catch (err) {
    logger.error('Erro no webhook Cal.eu', { triggerEvent, uid, error: err.message });
  }
}

async function handleCreated(uid, startTime, payload) {
  logger.info('Nova reserva via webhook Cal.eu', { uid, startTime });

  // Se o lead já existe (criado pela api.js), não duplicar
  const existingLead = await findLeadByBookingUid(uid);
  if (existingLead) {
    logger.info('Lead já existe para esta reserva — webhook ignorado', { uid, leadId: existingLead.id });
    return;
  }

  const attendee = payload?.attendees?.[0];
  const name     = attendee?.name  || 'Cliente';
  const email    = attendee?.email || null;
  const phone    = attendee?.phoneNumber || null;

  // Mapear serviço/duração a partir do slug do event type
  const serviceSlug = (payload?.eventType || payload?.type || '').toLowerCase();
  let service  = 'relaxante';
  let duration = 60;
  let location = 'Lisboa';

  if (serviceSlug.includes('bliss')) {
    service  = 'bliss';
    duration = serviceSlug.includes('90') ? 90 : 60;
  } else if (serviceSlug.includes('relaxante')) {
    service  = 'relaxante';
    duration = serviceSlug.includes('30') ? 30 : serviceSlug.includes('90') ? 90 : 60;
  }
  if (serviceSlug.includes('domicilio')) location = 'Domicilio';

  const { date: bookingDate, time: bookingTime } = utcToLisbon(startTime);

  const result = await createOrUpdateLead({
    name, phone, email, service, location,
    bookingUid:  uid,
    bookingDate, bookingTime, duration,
    isReturningClient: false,
    source:   'Cal.eu',
    language: 'pt',
  });

  logger.info('Lead criado via webhook Cal.eu', { uid, leadId: result?.leadId, name });
}

async function handleReschedule(oldUid, newUid, newStartTime, payload) {
  logger.info('Reschedule detectado via webhook', { oldUid, newUid, newStartTime });

  // No payload do Cal.eu: 'uid' = NOVO booking, 'rescheduleUid' = ORIGINAL
  const originalUid   = payload?.rescheduleUid || oldUid;
  const newBookingUid = payload?.uid || newUid;

  const lead = await findLeadByBookingUid(originalUid);
  if (!lead) {
    logger.warn('Lead não encontrado para reschedule', { originalUid, newBookingUid });
    return;
  }

  // Nova data/hora — Cal.eu envia UTC (.000Z); converter para Lisboa antes de usar no título
  const { date: bookingDate, time: bookingTime } = utcToLisbon(newStartTime);
  const newTs  = newStartTime ? Math.floor(new Date(newStartTime).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const newUrl = `https://cal.com/booking/${newBookingUid}`;

  // Dados do cliente e serviço a partir do payload
  const attendee    = payload?.attendees?.[0];
  const clientName  = attendee?.name  || 'Cliente';
  const clientPhone = attendee?.phoneNumber || null;

  const serviceSlug = (payload?.eventType || payload?.type || '').toLowerCase();
  let service  = 'relaxante';
  let duration = 60;
  let location = 'Lisboa';
  if (serviceSlug.includes('bliss'))     { service = 'bliss'; duration = serviceSlug.includes('90') ? 90 : 60; }
  else if (serviceSlug.includes('relax')) { service = 'relaxante'; duration = serviceSlug.includes('30') ? 30 : serviceSlug.includes('90') ? 90 : 60; }
  if (serviceSlug.includes('domicilio')) location = 'Domicilio';

  const newLeadName = formatLeadName(clientName, service, duration, location, clientPhone, bookingDate, bookingTime);

  // 1. Actualizar campos da reserva + título do lead
  await updateLeadFields(lead.id, {
    [FIELD.BOOKING_DATE]: newTs,
    [FIELD.BOOKING_URL]:  newUrl,
  }, {}, newLeadName);

  // 2. Passar por "Reagendar" — registo histórico no pipeline
  await moveLeadToStage(lead.id, 'Reagendar', {}, lead.pipeline_id);

  // 3. Mover para "Agendado" — dispara o trigger Kommo → WhatsApp ao cliente
  await moveLeadToStage(lead.id, 'Agendado', {}, lead.pipeline_id);

  // 4. Override do STATUS para REAGENDADO (moveLeadToStage("Agendado") põe STATUS_AGENDADO)
  await updateLeadFields(lead.id, {
    [FIELD.STATUS]: ENUM.STATUS_REAGENDADO,
  }, { [FIELD.STATUS]: true });

  logger.info('Lead actualizado após reschedule', {
    leadId: lead.id, originalUid, newBookingUid, newDate: bookingDate, newTime: bookingTime,
  });
}

async function handleCancellation(uid, payload) {
  logger.info('Cancelamento detectado via webhook', { uid });

  const bookingUid  = payload?.uid || uid;
  const originalUid = payload?.rescheduleUid;

  // 1ª tentativa: UID actual do booking
  let lead = await findLeadByBookingUid(bookingUid);

  // 2ª tentativa: UID original (caso seja um reschedule → cancel)
  if (!lead && originalUid && originalUid !== bookingUid) {
    lead = await findLeadByBookingUid(originalUid);
  }

  if (!lead) {
    logger.warn('Lead não encontrado para cancelamento', { uid, bookingUid, originalUid });
    return;
  }

  await moveLeadToStage(lead.id, 'Cancelado', {}, lead.pipeline_id);
  logger.info('Lead movido para Cancelado', { leadId: lead.id });
}

module.exports = { handleCalEuWebhook };
