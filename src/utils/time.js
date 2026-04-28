/**
 * Utilitários de data/hora para o fuso horário de Lisboa.
 */

/**
 * Devolve o offset UTC de Lisboa para uma data (YYYY-MM-DD).
 * WEST (UTC+1): Abril–Outubro. WET (UTC+0): Novembro–Março.
 */
function getLisbonOffset(dateStr) {
  const month = parseInt(dateStr.split('-')[1], 10);
  return (month >= 4 && month <= 10) ? '+01:00' : '+00:00';
}

/**
 * Constrói um timestamp ISO com o offset correcto de Lisboa.
 * Ex: toIsoLisbon('2026-04-12', '10:30') → '2026-04-12T10:30:00+01:00'
 */
function toIsoLisbon(date, time) {
  return `${date}T${time || '10:00'}:00${getLisbonOffset(date)}`;
}

/**
 * Converte um timestamp UTC (ISO string) para data e hora em Lisboa.
 * Devolve { date: 'YYYY-MM-DD', time: 'HH:MM' } ou { date: null, time: null }.
 */
function utcToLisbon(isoStr) {
  if (!isoStr) return { date: null, time: null };
  const dt    = new Date(isoStr);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(dt);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`,
  };
}

module.exports = { getLisbonOffset, toIsoLisbon, utcToLisbon };
