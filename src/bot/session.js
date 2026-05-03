const sessions = new Map();
const TTL = 30 * 60 * 1000; // 30 minutos

function getSession(chatId) {
  const s = sessions.get(chatId);
  if (s && Date.now() - s.lastSeen < TTL) {
    s.lastSeen = Date.now();
    return s;
  }
  const fresh = {
    chatId,
    name:         null,
    source:       null,  // chave do sources.json (terapeutica, relaxamento, ...)
    state:        'NEW', // NEW | QUALIFYING | QUALIFIED | AWAITING_LOCATION
    lastVariants: {},    // intent → variantId (para A/B tracking)
    lastSeen:     Date.now(),
  };
  sessions.set(chatId, fresh);
  return fresh;
}

function resetSession(chatId) {
  sessions.delete(chatId);
}

function getActiveSessions() {
  const now = Date.now();
  return [...sessions.values()].filter(s => now - s.lastSeen < TTL);
}

module.exports = { getSession, resetSession, getActiveSessions };
