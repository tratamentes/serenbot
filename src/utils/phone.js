/**
 * Normalização de números de telefone para formato E.164.
 * Centralizado — usado sempre que se guarda ou compara um telefone.
 */

function normalizePhone(phone) {
  if (!phone) return null;
  const clean = phone.replace(/[^\d+]/g, ''); // remove tudo excepto dígitos e +
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('351') && clean.length === 12) return `+${clean}`;
  if (clean.length === 9) return `+351${clean}`;                           // português
  if (clean.length === 10 && /^[2-9]/.test(clean)) return `+1${clean}`;   // americano
  return clean || null;
}

module.exports = { normalizePhone };
