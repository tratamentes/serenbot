const path = require('path');
const PATTERNS = require(path.join(__dirname, '../../data/intents.json'));

// Respostas numéricas à pergunta de qualificação
const QUALIFY_DIGITS = {
  '1': 'terapeutica', '2': 'relaxamento', '3': 'lomi', '4': 'sueca', '5': null,
};

// Palavras-raiz (substring) que mapeiam para um serviço — normalizado sem acentos
const SOURCE_KEYWORDS = {
  terapeutica: [
    // serviço explícito
    'terapeutica', 'terapia', 'terapias',
    // dores e queixas físicas
    'dor', 'dores', 'doi', 'doer',
    'tensao', 'tenso', 'tensa', 'tensoes',
    'contractura', 'contratura', 'contraturas',
    'cervical', 'cervicais',
    'lombar', 'lombares',
    'ciatica', 'ciatalgia',
    'ombro', 'ombros',
    'costas', 'coluna',
    'pescoco', 'nuca',
    'muscular', 'musculo', 'musculos',
    'cronica', 'cronico',
    'inflamac', 'inflama',
    'rigidez', 'rigida', 'rigido',
    'bloqueio', 'bloqueada', 'bloqueado',
    'preso', 'presa',
    'nodo', 'nodulo',
    'knot', // inglês comum
    // adjetivos de intensidade que costumam ser dor
    'muito tenso', 'muito tensa',
  ],

  relaxamento: [
    // serviço explícito
    'relaxamento', 'relaxante', 'relaxar', 'relaxacao', 'relaxar',
    'anti-stress', 'antistress', 'anti stress',
    // estado emocional / motivação
    'stress', 'stressad', 'stressada', 'stressado',
    'ansiedade', 'ansios',
    'cansaco', 'cansada', 'cansado', 'esgotada', 'esgotado',
    'fadiga', 'exaust',
    'descanso', 'descansar', 'descanso',
    'desligar', 'desligar-me',
    'pausa', 'momento para mim',
    'bem-estar', 'bemestar', 'bem estar',
    'cansa', // cansaço, cansada, cansaca (autocorrect)
    'mimar', 'mimado', 'mimada', 'mimar-me',
    'presente', // "quero dar um presente"
    'prenda',
    'oferta',
    'voucher',
    'regalo',
    // técnicas sinónimas de relaxamento
    'californiana', 'california',
    'aromaterapia', 'aromatic', 'aromatico',
    'oleos essenciais', 'oleos', 'oleo',
    'sensitiva', 'sensorial',
    'neurossedativa', 'neurossedativo',
    'classica', 'classico', // "massagem clássica" = relaxamento
  ],

  lomi: [
    'lomi',
    'havaiana', 'havaiano', 'havai',
    'hawaii',
    'onda', // "como uma onda" é descrição lomi
  ],

  sueca: [
    'sueca', 'sueco', 'swedish',
    'effleurage', 'petrissage',
    'circulacao', // "activar a circulação" → sueca
  ],

  visceral: [
    'visceral', 'viscer',
    'digestiv', 'digestao',
    'intestin', 'intestinos',
    'abdomen', 'abdominal',
    'estomago', 'figado',
    'barriga',
  ],

  quantum: [
    'quantum', 'quantun', 'quatum',
    'energi', // "energética"
    'bioener',
    'chakra',
    'reiki', // parecido / confundido
    'bioenerg',
  ],
};

function normalize(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function matchesPattern(s, pattern) {
  const p = normalize(pattern);
  // Padrões curtos (≤3 chars) exigem palavra completa para evitar falsos positivos
  // ex: "vá"→"va" não deve bater em "nova", "s" não deve bater em "stress"
  if (p.length <= 3) {
    return new RegExp(`(?:^|\\s)${p}(?:\\s|$)`).test(s);
  }
  return s.includes(p);
}

function classifyIntent(text) {
  return classifyIntentDetailed(text).intent;
}

function classifyIntentDetailed(text) {
  const s = normalize(text);
  let best = { intent: 'unknown', score: 0 };
  let second = { intent: 'unknown', score: 0 };
  for (const [intent, patterns] of Object.entries(PATTERNS)) {
    if (!Array.isArray(patterns)) continue;
    const score = patterns.filter(p => matchesPattern(s, p)).length;
    if (score > best.score) {
      second = best;
      best = { intent, score };
    } else if (score > second.score) {
      second = { intent, score };
    }
  }
  const confidence = best.score === 0 ? 0
    : Math.min(0.95, 0.45 + (best.score * 0.18) + Math.max(0, best.score - second.score) * 0.08);
  return { ...best, secondIntent: second.intent, secondScore: second.score, confidence };
}

// Tenta identificar a origem/serviço a partir de texto livre (para qualificação orgânica)
function classifySource(text) {
  return classifySourceDetailed(text).source;
}

function classifySourceDetailed(text) {
  const s = normalize(text);
  const trimmed = s.trim();

  // Resposta numérica directa (1-5)
  if (QUALIFY_DIGITS[trimmed] !== undefined) {
    return { source: QUALIFY_DIGITS[trimmed], score: 1, confidence: QUALIFY_DIGITS[trimmed] ? 0.95 : 0 };
  }

  // Score por número de keywords encontradas (como classifyIntent)
  let best = { source: null, score: 0 };
  let second = { source: null, score: 0 };
  for (const [source, keywords] of Object.entries(SOURCE_KEYWORDS)) {
    const score = keywords.filter(kw => s.includes(normalize(kw))).length;
    if (score > best.score) {
      second = best;
      best = { source, score };
    } else if (score > second.score) {
      second = { source, score };
    }
  }
  const confidence = best.score === 0 ? 0
    : Math.min(0.95, 0.5 + (best.score * 0.16) + Math.max(0, best.score - second.score) * 0.08);
  return { ...best, secondSource: second.source, secondScore: second.score, confidence };
}

module.exports = { classifyIntent, classifyIntentDetailed, classifySource, classifySourceDetailed };
