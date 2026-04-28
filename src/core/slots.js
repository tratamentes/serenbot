/**
 * Algoritmo de selecção estratégica de slots.
 *
 * Objectivo: criar percepção de escassez mesmo com agenda vazia,
 * e encher a agenda de forma optimizada (clustering).
 *
 * Regras:
 *  - Agenda vazia (>70% livre)  → 3 slots estratégicos: manhã cedo, tarde cedo, 17h30
 *  - Agenda quase cheia (≤3 slots) → mostra os slots reais (escassez genuína)
 *  - Caso normal               → máximo 2 slots próximos da preferência do cliente
 */

const WORK_START_HOUR = 10; // 10h00
const WORK_END_HOUR   = 22; // 22h00

// Slots âncora para dias com agenda vazia
const ANCHOR_MORNING   = { h: 10, m: 0  }; // 10h00
const ANCHOR_AFTERNOON = { h: 14, m: 0  }; // 14h00
const ANCHOR_EVENING   = { h: 17, m: 30 }; // 17h30

/**
 * @param {Array<{ time: string, datetime: Date }>} available — slots livres do Cal.eu
 * @param {number} duration — duração da sessão em minutos
 * @param {Date|null} preferredTime — hora aproximada pedida pelo cliente (pode ser null)
 * @param {number} afterBuffer — buffer após sessão em minutos (vem do Cal.eu via event-types-cache)
 * @returns {Array<{ time: string, datetime: Date }>} — slots a apresentar ao cliente
 */
function selectSlots(available, duration, preferredTime = null, afterBuffer = 30) {
  if (available.length === 0) return [];

  // Escassez real — mostra todos (até 3)
  if (available.length <= 3) {
    return available.slice(0, 3);
  }

  // Cliente pediu hora específica
  if (preferredTime) {
    const prefMinutes = preferredTime.getHours() * 60 + preferredTime.getMinutes();

    // Verifica se o slot exacto pedido está disponível
    const exact = available.find(s => {
      const m = s.datetime.getHours() * 60 + s.datetime.getMinutes();
      return m === prefMinutes;
    });

    if (exact) return [exact]; // disponível → confirma directamente

    // Não disponível → mostra os 2 mais próximos como alternativas
    return selectClosestTo(available, preferredTime, 2);
  }

  // Calcula taxa de ocupação aproximada do dia
  const totalPossibleSlots = estimateTotalSlots(duration, afterBuffer);
  const occupancyRate = 1 - (available.length / totalPossibleSlots);

  // Agenda vazia → selecção estratégica (clustering)
  if (occupancyRate < 0.3) {
    return selectStrategicSlots(available);
  }

  // Caso normal → devolve todos os slots disponíveis
  return available;
}

/**
 * Selecção para agendas vazias: manhã cedo, tarde cedo, 17h30.
 */
function selectStrategicSlots(available) {
  const morning   = findClosestAfter(available, ANCHOR_MORNING);
  const afternoon = findClosestAfter(available, ANCHOR_AFTERNOON);
  const evening   = findClosestAfter(available, ANCHOR_EVENING);

  // Remove duplicados (pode acontecer se a agenda tiver poucos slots)
  const seen = new Set();
  return [morning, afternoon, evening].filter(slot => {
    if (!slot) return false;
    if (seen.has(slot.time)) return false;
    seen.add(slot.time);
    return true;
  });
}

/**
 * Encontra o primeiro slot disponível a partir de uma hora âncora.
 */
function findClosestAfter(available, anchor) {
  const target = anchor.h * 60 + anchor.m; // em minutos desde meia-noite
  return available.find(slot => {
    const slotMinutes = slot.datetime.getHours() * 60 + slot.datetime.getMinutes();
    return slotMinutes >= target;
  }) || null;
}

/**
 * Encontra os N slots mais próximos de uma hora preferida.
 */
function selectClosestTo(available, preferredTime, n) {
  const prefMinutes = preferredTime.getHours() * 60 + preferredTime.getMinutes();

  return [...available]
    .sort((a, b) => {
      const aMin = a.datetime.getHours() * 60 + a.datetime.getMinutes();
      const bMin = b.datetime.getHours() * 60 + b.datetime.getMinutes();
      return Math.abs(aMin - prefMinutes) - Math.abs(bMin - prefMinutes);
    })
    .slice(0, n)
    .sort((a, b) => a.datetime - b.datetime); // reordena cronologicamente
}

/**
 * Estima slots possíveis num dia para uma dada duração.
 * Das 10h às 22h = 720 minutos.
 * Cada slot ocupa duration + afterBuffer (buffer configurado no Cal.eu).
 */
function estimateTotalSlots(duration, afterBuffer = 30) {
  return Math.floor((WORK_END_HOUR - WORK_START_HOUR) * 60 / (duration + afterBuffer));
}

/**
 * Formata slots para apresentar ao Claude (texto legível).
 */
function formatSlotsForClaude(slots) {
  if (slots.length === 0) return 'Sem vagas disponíveis para este dia.';

  return slots
    .map(slot => {
      const d = slot.datetime;
      const hours   = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      return `${hours}h${minutes}`;
    })
    .join(' | ');
}

module.exports = { selectSlots, formatSlotsForClaude };
