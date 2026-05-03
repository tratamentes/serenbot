const fs   = require('fs');
const path = require('path');
const { createClient } = require('../utils/http');
const { pickVariant, fillTemplate, recordContinued } = require('./ab-responses');

const QUEUE_FILE = path.join(__dirname, '../../data/followup-queue.json');
const CAL_BASE   = 'https://cal.com/joao-goulart-tratamentes-lisboa-cascais';
const http       = createClient('https://api.telegram.org');

// FU1: 60min, FU2: 60min + 23h, FU3: FU2 + 24h
const FU_DELAYS = [60 * 60 * 1000, 23 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

let queue = {};

function loadQueue() {
  try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { queue = {}; }
}

function saveQueue() {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

function scheduleFollowUps(chatId, name, painDesire) {
  const now = Date.now();
  queue[chatId] = {
    name,
    painDesire: painDesire || 'melhorar o seu bem-estar',
    nextFuAt:   now + FU_DELAYS[0],
    fuIndex:    0,  // 0=FU1 por enviar, 1=FU2, 2=FU3, 3=terminado
    cancelled:  false,
    lastVariants: {},
  };
  saveQueue();
}

function cancelFollowUps(chatId) {
  if (queue[chatId] && !queue[chatId].cancelled) {
    queue[chatId].cancelled = true;
    // registar continued para a última variante de FU enviada
    const { lastVariants, fuIndex } = queue[chatId];
    if (fuIndex > 0) {
      const lastKey = `followup_${fuIndex}`;
      const lastVid = lastVariants[lastKey];
      if (lastVid) recordContinued(lastKey, lastVid);
    }
    saveQueue();
  }
}

function cancelFollowUpsByContact(phone, email) {
  // chamado pelo webhook Cal.com quando há reserva — cruza por chatId não disponível aqui,
  // mas podemos marcar todos os que tenham o mesmo nome/contacto se quisermos.
  // Por agora: não há ligação directa phone↔chatId sem passar pelo Kommo.
  // Deixamos para fase futura — o cancelamento por resposta do utilizador já cobre 90% dos casos.
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_TOKEN_AGENT1;
  if (!token) return;
  await http.post(`/bot${token}/sendMessage`, {
    chat_id:    chatId,
    text,
    parse_mode: 'Markdown',
  }).catch(() => {});
}

function tick() {
  const now = Date.now();
  let changed = false;

  for (const [chatId, entry] of Object.entries(queue)) {
    if (entry.cancelled || entry.fuIndex >= 3) continue;
    if (now < entry.nextFuAt) continue;

    const fuKey = `followup_${entry.fuIndex + 1}`;
    const session = { lastVariants: entry.lastVariants };
    const template = pickVariant(fuKey, session);
    if (!template) { entry.fuIndex++; changed = true; continue; }

    entry.lastVariants = session.lastVariants;
    const text = fillTemplate(template, {
      nome:       entry.name || '',
      dordesejo:  entry.painDesire,
      url:        CAL_BASE,
    });

    sendTelegramMessage(chatId, text);

    entry.fuIndex++;
    if (entry.fuIndex < 3) {
      entry.nextFuAt = now + FU_DELAYS[entry.fuIndex];
    } else {
      entry.cancelled = true;
    }
    changed = true;
  }

  // Limpar entradas terminadas mais antigas que 48h
  for (const [chatId, entry] of Object.entries(queue)) {
    if ((entry.cancelled || entry.fuIndex >= 3) && now - (entry.nextFuAt || 0) > 48 * 60 * 60 * 1000) {
      delete queue[chatId];
      changed = true;
    }
  }

  if (changed) saveQueue();
}

loadQueue();
setInterval(tick, 60 * 1000);

module.exports = { scheduleFollowUps, cancelFollowUps, cancelFollowUpsByContact };
