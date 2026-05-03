const crypto = require('crypto');
const { createClient } = require('../utils/http');

const http  = createClient('https://openrouter.ai');
const cache = new Map(); // hash → { reply, expiresAt }
const TTL   = 24 * 60 * 60 * 1000;

const SYSTEM = `És a Seren, recepcionista virtual da Tratamentes (terapias holísticas e musculoesqueléticas, Lisboa e Cascais).
Responde em português europeu. Máximo 2 frases curtas. Não inventes serviços, preços ou datas.
Se a pergunta for inapropriada, ofensiva ou fora do âmbito, recusa com educação e redireciona: "Isso está fora do que posso ajudar. Posso marcar uma sessão ou responder a dúvidas sobre os nossos tratamentos."
Se não souberes, diz: "Não tenho essa informação — podes ver mais em tratamentes.pt"`;

async function llmFallback(text) {
  const key = crypto.createHash('sha256').update(text.toLowerCase().trim()).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.reply;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return 'Isso está fora do que posso ajudar. Posso marcar uma sessão ou responder a dúvidas sobre os nossos tratamentos.';

  try {
    const { data } = await http.post('/api/v1/chat/completions', {
      model: 'google/gemini-flash-1.5',
      max_tokens: 150,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: text },
      ],
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'https://api.tratamentes.pt',
      },
    });

    const reply = data?.choices?.[0]?.message?.content?.trim()
      || 'Isso está fora do que posso ajudar. Posso marcar uma sessão ou responder a dúvidas sobre os nossos tratamentos.';

    cache.set(key, { reply, expiresAt: Date.now() + TTL });
    return reply;
  } catch {
    return 'Isso está fora do que posso ajudar. Posso marcar uma sessão ou responder a dúvidas sobre os nossos tratamentos.';
  }
}

module.exports = { llmFallback };
