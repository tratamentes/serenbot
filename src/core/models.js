/**
 * MBTP Core Models - O "Contrato" de Dados
 * 
 * Este ficheiro define a estrutura única (UnifiedBooking) que serve de ponte
 * entre as APIs externas (Cal.eu, Kommo) e a lógica interna.
 * 
 * Auditoria:
 * - Senior: Garante desacoplamento total das APIs externas.
 * - Junior: Proporciona autocompletar e clareza no acesso aos dados.
 * - Auditor Crítico: Centraliza a validação para o Graphify.
 */

/**
 * @typedef {Object} UnifiedBooking
 * @property {string} id - UID único da reserva (Cal.eu)
 * @property {string} startTime - ISO String da data/hora de início
 * @property {string} endTime - ISO String da data/hora de fim
 * @property {string} status - CANCELLED, ACCEPTED, PENDING
 * @property {Object} client
 * @property {string} client.name - Nome completo do cliente
 * @property {string} client.email - Email real ou sintético
 * @property {string} client.phone - Telefone normalizado
 * @property {string} [client.telegramId] - ID do Telegram (se disponível)
 * @property {Object} service
 * @property {string} service.slug - ex: massagem-bliss-touch-60
 * @property {string} service.name - Nome legível do serviço
 * @property {number} service.duration - Duração em minutos
 * @property {Object} [metadata] - Campos extra (NIF, morada, etc)
 */

/**
 * Mapeia os dados brutos da Cal.eu V2 para o modelo unificado.
 * @param {Object} raw - Resposta da API Cal.eu
 * @returns {UnifiedBooking}
 */
function mapCalcomToUnified(raw) {
    if (!raw) return null;
    
    // O ID pode vir em campos diferentes dependendo do endpoint da Cal.eu
    const id = raw.uid || raw.id;
    if (!id) {
        console.error("[Models] Tentativa de mapear agendamento sem ID", raw);
        return null;
    }

    // Extração robusta de cliente (Cal.eu muda conforme é webhook ou query)
    const attendee = raw.attendees?.[0] || {};
    const responses = raw.responses || {};

    return {
        id: id,
        // Cal.eu usa `start`/`end` nas respostas REST e `startTime`/`endTime` nos webhooks
        startTime: raw.startTime || raw.start,
        endTime: raw.endTime || raw.end,
        status: (raw.status || 'ACCEPTED').toUpperCase(),
        client: {
            name: attendee.name || responses.name || "Cliente",
            email: attendee.email || responses.email || null,
            phone: attendee.phoneNumber || responses.location || null,
        },
        service: {
            slug: raw.eventType?.slug || "sessao-manual",
            name: raw.eventType?.title || "Massagem",
            duration: raw.eventType?.length || 60,
        },
        metadata: {
            nif: responses.NIF || null,
            address: responses.address || null,
            rescheduleUid: raw.rescheduleUid || null
        }
    };
}

module.exports = {
    mapCalcomToUnified
};
