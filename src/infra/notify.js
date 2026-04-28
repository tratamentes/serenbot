/**
 * Notificações Telegram para o admin (Paulo via Bot B).
 * Módulo separado para evitar dependência circular api.js ↔ webhook.js.
 */

const logger = require('../utils/logger');
const { createClient } = require('../utils/http');

const http = createClient('https://api.telegram.org');

async function sendToAdmin(lines) {
  const token   = process.env.TELEGRAM_BOT_B_TOKEN;
  const adminId = process.env.TELEGRAM_ADMIN_ID;
  if (!token || !adminId) return;
  try {
    await http.post(`/bot${token}/sendMessage`, {
      chat_id: adminId,
      text: lines.join('\n'),
      parse_mode: 'Markdown'
    });
  } catch (err) {
    logger.warn('Notificação admin falhou', err.message);
  }
}

/**
 * Notifica o Paulo (Bot B) sobre uma nova reserva usando o agendamento unificado.
 * @param {UnifiedBooking} booking 
 */
async function notifyBooking(booking) {
  if (!booking) return;

  const hora = new Date(booking.startTime).toLocaleString('pt-PT', {
    timeZone: 'Europe/Lisbon', dateStyle: 'short', timeStyle: 'short',
  });

  const lines = [
    `🗓 *Nova reserva*`, ``,
    `👤 ${booking.client.name}`,
    `📅 ${hora}`,
    `💆 ${booking.service.name} (${booking.service.duration}min)`,
  ];

  const email = booking.client.email;
  if (email && !email.startsWith('sem-email') && !email.startsWith('no-reply')) lines.push(`📧 ${email}`);
  if (booking.client.phone) lines.push(`📱 ${booking.client.phone}`);
  if (booking.metadata?.nif) lines.push(`🧾 NIF: ${booking.metadata.nif}`);
  if (booking.metadata?.address) lines.push(`🏠 Morada: ${booking.metadata.address}`);

  lines.push(``, `🔗 cal.eu/booking/${booking.id}`);
  return sendToAdmin(lines);
}

/**
 * Notifica reagendamento usando o agendamento unificado.
 * @param {UnifiedBooking} booking 
 */
async function notifyReschedule(booking, oldStart) {
  const fmt = { timeZone: 'Europe/Lisbon', dateStyle: 'short', timeStyle: 'short' };
  const oldDate = oldStart ? new Date(oldStart).toLocaleString('pt-PT', fmt) : '—';
  const newDate = new Date(booking.startTime).toLocaleString('pt-PT', fmt);

  const lines = [
    `📅 *Reserva reagendada*`, ``,
    `👤 ${booking.client.name}`,
    `📱 ${booking.client.phone || '—'}`,
    ``,
    `De: ${oldDate}`,
    `Para: ${newDate}`,
    ``,
    `🔗 cal.eu/booking/${booking.id}`
  ];
  return sendToAdmin(lines);
}

/**
 * Notifica cancelamento usando o UID da reserva.
 */
async function notifyCancel(uid, { name, phone, reason }) {
  const lines = [`❌ *Reserva cancelada*`, ``];
  if (name)   lines.push(`👤 ${name}`);
  if (phone)  lines.push(`📱 ${phone}`);
  if (reason) lines.push(`📝 Motivo: ${reason}`);
  lines.push(``, `🔗 cal.eu/booking/${uid}`);
  return sendToAdmin(lines);
}

module.exports = { notifyBooking, notifyCancel, notifyReschedule, sendToAdmin };
