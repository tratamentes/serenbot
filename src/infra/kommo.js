const { mapCalcomToUnified } = require('../core/models');
const logger = require('../utils/logger');
const { createClient } = require('../utils/http');
const { normalizePhone } = require('../utils/phone');
const { getLisbonOffset } = require('../utils/time');

const SUBDOMAIN          = process.env.KOMMO_SUBDOMAIN;
const TOKEN              = process.env.KOMMO_ACCESS_TOKEN;
const RESPONSIBLE_USER   = parseInt(process.env.KOMMO_RESPONSIBLE_USER_ID || '0', 10);

const PIPELINE_ID            = parseInt(process.env.KOMMO_PIPELINE_ID            || '0', 10);
const PIPELINE_ATIVOS        = parseInt(process.env.KOMMO_PIPELINE_ATIVOS_ID     || '0', 10);
const STATUS_AGENDADO        = parseInt(process.env.KOMMO_STATUS_AGENDADO        || '0', 10);
const STATUS_ATIVOS_AGENDADO = parseInt(process.env.KOMMO_STATUS_ATIVOS_AGENDADO || '0', 10);

// Stage IDs dentro de cada pipeline — específicos da conta Kommo.
// Para obter: GET /api/v4/leads/pipelines/{PIPELINE_ID}/statuses
// Actualizar quando criar ou renomear stages no Kommo.
const STAGE = {
  ativos: {
    Novo:        '100167907',
    Agendado:    '100167911',
    Confirmado:  '100168079',
    Reagendar:   '103625251',
    Compareceu:  '100168083',
    'No-show':   '100167915',
    Cancelado:   '103625295',
    'Nova Sessão':'100168087',
  },
  principal: {
    Novo:        '100166763',
    Agendado:    '99528395',
    Confirmado:  '100166467',
    Reagendar:   '102219243',
    Compareceu:  '100166559',
    'No-show':   '100166471',
    Cancelado:   '102292427',
  },
};

// IDs dos campos customizados — específicos da conta Kommo.
// Para obter os teus IDs: Kommo → Configurações → Campos → inspecionar via API /api/v4/contacts/custom_fields
// Se o Kommo mudar um campo: só editar nesta secção.
const FIELD = {
  // Contact
  CONTACT_TELEGRAM:          4323976,   // Telegram ID (text)
  CONTACT_IDIOMA:            4320480,   // Idioma (enum)
  CONTACT_ORIGEM:            4211717,   // Origem (enum)
  CONTACT_SUBORIGEM:         4206262,   // Sub-origem (enum)
  CONTACT_PRIMEIRO_CONTATO:  3905164,   // Data do Primeiro Contato (date)
  // Lead — reserva
  BOOKING_URL:    4321292,   // URL da reserva Cal.eu (text)
  BOOKING_DATE:   4206224,   // Data da sessão (date)
  STATUS:         4222354,   // Status Agendamento (enum)
  ENVIAR_AGENDA:  4225784,   // Enviar Agenda (checkbox)
  PROCEDIMENTO:   4222286,   // Procedimento (enum)
  LOCAL:          4216812,   // Local da Sessão (enum)
  FONTE_RESERVA:  4323716,   // Fonte de Reserva (enum)
  TIPO_SESSAO:    4206238,   // Tipo de Sessão (enum)
  MOEDA:          4223356,   // Moeda (enum)
  LEAD_ORIGEM:    4206228,   // Origem do Lead (enum)
  LEAD_SUBORIGEM: 4206230,   // Sub-origem do Lead (enum)
  INTERESSE:      4206234,   // Interesse (enum)
  NOTAS:          4206242,   // Notas (text)
  // Timestamps de stage (preenchidos automaticamente ao mover)
  TS_NOVO:        4223726,
  TS_AGENDADO:    4223734,
  TS_CONFIRMADO:  4223740,
  TS_REAGENDAR:   4223736,
  TS_COMPARECEU:  4223744,
  TS_NO_SHOW:     4223742,
  TS_CANCELADO:   4223738,
  TS_NOVA_SESSAO: 4223746,
};

// Alias para retrocompatibilidade (findClientByTelegramId usa esta constante)
const TELEGRAM_FIELD_ID = FIELD.CONTACT_TELEGRAM;

const ENUM = {
  // Contact: Sexo (field 4206248)
  SEXO_MASCULINO: 7914090,
  SEXO_FEMININO:  7914092,
  SEXO_OUTRO:     7914094,
  // Contact: Origem (field 4211717)
  ORIGEM_ORGANICO:      7921655,
  ORIGEM_TRAFEGO_PAGO:  7921659,
  ORIGEM_INDICACAO:     7914058,
  ORIGEM_PROSPECCAO:    7914054,
  // Contact: Sub-origem (field 4206262)
  SUBORIGEM_GOOGLE:    7914110,
  SUBORIGEM_FACEBOOK:  7914108,
  SUBORIGEM_INSTAGRAM: 7914106,
  SUBORIGEM_WEBSITE:   7914104,
  SUBORIGEM_NAO_SEI:   7915264,
  SUBORIGEM_C1:        7929312,
  SUBORIGEM_C2:        7929314,
  // Contact: Idioma (field 4320480)
  IDIOMA_PT: 7947106,
  IDIOMA_EN: 7947108,
  // Lead: Status Agendamento (field 4222354)
  STATUS_AGENDAR:       7936532,
  STATUS_AGENDADO:      7936534,
  STATUS_REAGENDADO:    7936536,
  STATUS_CANCELOU:      7936538,
  STATUS_REAGENDAMENTO: 7937378,
  STATUS_NO_SHOW:       7947250,
  // Lead: Tipo de Sessão (field 4206238)
  TIPO_AVALIACAO:       7914082,
  TIPO_ACOMPANHAMENTO:  7914084,
  // Lead: Procedimento (field 4222286)
  PROCED_BLISS_60:  7936508,
  PROCED_BLISS_90:  7936504,
  PROCED_RELAX_30:  7936510,
  PROCED_RELAX_60:  7941754,
  PROCED_RELAX_90:  7945066,
  // Lead: Local da Sessão (field 4216812)
  LOCAL_LISBOA:    7929474,
  LOCAL_CASCAIS:   7929476,
  LOCAL_DOMICILIO: 7931713,
  // Lead: LEAD Origem (4206228)
  LEAD_ORIGEM_ORGANICO:     7914056,
  LEAD_ORIGEM_TRAFEGO_PAGO: 7914060,
  LEAD_ORIGEM_INDICACAO:    7914058,
  LEAD_ORIGEM_PROSPECCAO:   7914054,
  // Lead: Sub-origem (4206230)
  LEAD_SUB_C1:      7929324,
  LEAD_SUB_C2:      7929326,
  LEAD_SUB_FB:      7914108,
  LEAD_SUB_IG:      7914106,
  LEAD_SUB_GOOGLE:  7914068,
  LEAD_SUB_WEBSITE: 7914104,
  LEAD_SUB_NAO:     7915258,
  // Lead: Fonte de Reserva (4323716)
  FONTE_CALCOM: 7950152,
  FONTE_CALEU:  7950154,
  // Lead: Moeda (field 4223356)
  MOEDA_EUR: 7937298,
  // Lead: Interesse (4206234)
  INTERESSE_TERAPEUTICA_60:  7914072,
  INTERESSE_TERAPEUTICA_90:  7914074,
  INTERESSE_DOMICILIO:       7914076,
  INTERESSE_RELAX_60:        7929336,
  INTERESSE_EXPRESS_30:      7929338,
  INTERESSE_RELAX_90:        7929340,
  INTERESSE_VISCERAL_60:     7929342,
  INTERESSE_QUANTUM_60:      7929344,
  INTERESSE_PLANO_RELAX_60:  7929346,
  INTERESSE_PLANO_RELAX_90:  7929348,
  INTERESSE_PLANO_RELAX_30:  7946642,
  INTERESSE_PLANO_RELAX_25:  7946644,
};

const client = createClient(
  `https://${SUBDOMAIN}.kommo.com/api/v4`,
  { Authorization: `Bearer ${TOKEN}` },
  30000,
);

// ─── LOOKUP ───────────────────────────────────────────────────────────────────

async function findClientByPhone(phone) {
  if (!SUBDOMAIN || !TOKEN) {
    logger.warn('Kommo não configurado — a saltar pesquisa de cliente');
    return null;
  }

  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  try {
    const response = await client.get('/contacts', {
      params: { query: normalized, limit: 1, with: 'custom_fields,leads' },
    });

    const contacts = response.data?._embedded?.contacts || [];
    if (!contacts.length) return null;

    const contact    = contacts[0];
    const leads      = response.data?._embedded?.leads?.[contact.id] || [];
    const activeLead = leads.find(l => !l.closed_at);

    return {
      id:              contact.id,
      name:            contact.name,
      phone:           normalized,
      lastSession:     extractCustomField(contact, 'Última Sessão'),
      service:         extractCustomField(contact, 'Serviço Preferido'),
      location:        extractCustomField(contact, 'Local Habitual'),
      leadId:          activeLead?.id          || null,
      leadPipelineId:  activeLead?.pipeline_id || null,
      origem:          extractCustomField(contact, 'Origem'),
      suborigem:       extractCustomField(contact, 'Sub-origem'),
    };
  } catch (err) {
    logger.error('Kommo findClientByPhone falhou', err);
    return null;
  }
}

async function findClientByTelegramId(telegramId) {
  if (!SUBDOMAIN || !TOKEN || !telegramId) return null;

  try {
    const response = await client.get('/contacts', {
      params: { query: String(telegramId), limit: 5, with: 'custom_fields,leads' },
    });

    for (const contact of response.data?._embedded?.contacts || []) {
      // Verifica que o match é mesmo no campo Telegram ID e não noutro campo
      const tgField = contact.custom_fields_values?.find(f => f.field_id === TELEGRAM_FIELD_ID);
      if (String(tgField?.values?.[0]?.value || '') !== String(telegramId)) continue;

      const leads      = response.data?._embedded?.leads?.[contact.id] || [];
      const activeLead = leads.find(l => !l.closed_at);

      return {
        id:             contact.id,
        name:           contact.name,
        leadId:         activeLead?.id          || null,
        leadPipelineId: activeLead?.pipeline_id || null,
        origem:         extractCustomField(contact, 'Origem'),
        suborigem:      extractCustomField(contact, 'Sub-origem'),
      };
    }
    return null;
  } catch (err) {
    logger.error('Kommo findClientByTelegramId falhou', err.message);
    return null;
  }
}

async function findLeadByBookingUid(bookingUid) {
  if (!SUBDOMAIN || !TOKEN) return null;

  try {
    // Kommo exige mínimo 6 chars; usa os primeiros 8 do UID como filtro inicial.
    // O match real é verificado linha a linha pelo URL completo (bookingUrl.includes(bookingUid)).
    // limit: 50 para cobrir casos com muitos leads com prefixo semelhante.
    const minQuery  = bookingUid.substring(0, 8);
    const searchRes = await client.get('/leads', {
      params: { query: minQuery, limit: 50, with: 'custom_fields' },
    });

    for (const lead of searchRes.data?._embedded?.leads || []) {
      const bookingField = lead.custom_fields_values?.find(f => f.field_id === FIELD.BOOKING_URL);
      const bookingUrl   = bookingField?.values?.[0]?.value || '';
      if (bookingUrl && bookingUrl.includes(bookingUid)) {
        logger.info('Lead encontrado', { leadId: lead.id, bookingUid });
        return lead;
      }
    }

    logger.warn('Nenhum lead encontrado com UID', { bookingUid });
    return null;
  } catch (err) {
    logger.error('Kommo findLeadByBookingUid falhou', err.message);
    return null;
  }
}

// ─── CRIAR / ACTUALIZAR LEAD ──────────────────────────────────────────────────

async function createOrUpdateLead({
  name, phone, service, location, bookingUid, bookingUrl, bookingDate, bookingTime,
  duration, telegramId, isReturningClient = false, source = 'Telegram', language = 'pt',
  interest = null, email = null, nif = null,
  utmSource = null, utmMedium = null, utmCampaign = null, referrer = null,
  contactOrigem = null, contactSuborigem = null, conversationNotes = null,
}) {
  if (!SUBDOMAIN || !TOKEN) {
    logger.warn('Kommo não configurado — a saltar criação de lead');
    return null;
  }

  try {
    const existingContact = await findClientByPhone(phone);
    let contactId         = existingContact?.id;
    const now             = Math.floor(Date.now() / 1000);
    const normalizedPhone = normalizePhone(phone);

    // ── Contacto ─────────────────────────────────────────────────────────────
    const contactFields = [
      { field_code: 'PHONE', values: [{ value: normalizedPhone, enum_code: 'MOB' }] },
    ];

    if (email && email.includes('@') && !email.startsWith('no-reply') && !email.startsWith('sem-email')) {
      contactFields.push({ field_code: 'EMAIL', values: [{ value: email, enum_code: 'WORK' }] });
    }

    const langEnumId = language === 'en' ? ENUM.IDIOMA_EN : ENUM.IDIOMA_PT;
    contactFields.push({ field_id: FIELD.CONTACT_IDIOMA, values: [{ enum_id: langEnumId }] });

    // Telegram ID — actualiza sempre (pode ter sido criado sem ele)
    if (telegramId) {
      contactFields.push({ field_id: FIELD.CONTACT_TELEGRAM, values: [{ value: String(telegramId) }] });
    }

    // Campos só para novos contactos
    if (!existingContact) {
      contactFields.push({ field_id: FIELD.CONTACT_PRIMEIRO_CONTATO, values: [{ value: now }] });

      const medium = (utmMedium || source || '').toLowerCase();
      const origemId = (medium === 'website' || (!utmMedium && source === 'Website'))
        ? ENUM.ORIGEM_ORGANICO
        : ENUM.ORIGEM_TRAFEGO_PAGO;
      contactFields.push({ field_id: FIELD.CONTACT_ORIGEM,    values: [{ enum_id: origemId }] });

      const subId = medium.includes('c2') ? ENUM.SUBORIGEM_C2 : ENUM.SUBORIGEM_C1;
      contactFields.push({ field_id: FIELD.CONTACT_SUBORIGEM, values: [{ enum_id: subId }] });
    }

    if (!contactId) {
      const contactRes = await client.post('/contacts', [{ name, custom_fields_values: contactFields }]);
      contactId = contactRes.data?._embedded?.contacts?.[0]?.id;
    }

    // ── Campos do Lead ────────────────────────────────────────────────────────
    const sessionTs      = bookingDate && bookingTime
      ? Math.floor(new Date(`${bookingDate}T${bookingTime}:00${getLisbonOffset(bookingDate)}`).getTime() / 1000)
      : null;
    const procedimentoId = mapServiceToEnum(service, duration);
    const localId        = mapLocationToEnum(location);
    const interesseId    = mapInterestToEnum(service, duration);
    const leadOrigemId   = mapOrigemLead(contactOrigem || utmSource, contactSuborigem || utmMedium);
    const leadSuborigemId= mapSuborigemLead(contactSuborigem || utmMedium);
    const bookingUrlFinal = bookingUid ? `https://cal.com/booking/${bookingUid}` : bookingUrl;

    // Campos de reserva (usados tanto na criação como na actualização)
    const bookingFields = [
      { field_id: FIELD.STATUS,        values: [{ enum_id: ENUM.STATUS_AGENDADO }] },
      { field_id: FIELD.ENVIAR_AGENDA, values: [{ value: true }] },
      ...(procedimentoId  ? [{ field_id: FIELD.PROCEDIMENTO,  values: [{ enum_id: procedimentoId }] }]  : []),
      ...(localId         ? [{ field_id: FIELD.LOCAL,         values: [{ enum_id: localId }] }]         : []),
      ...(sessionTs       ? [{ field_id: FIELD.BOOKING_DATE,  values: [{ value: sessionTs }] }]         : []),
      ...(bookingUrlFinal ? [
        { field_id: FIELD.BOOKING_URL,   values: [{ value: bookingUrlFinal }] },
        { field_id: FIELD.FONTE_RESERVA, values: [{ enum_id: ENUM.FONTE_CALEU }] },
      ] : []),
      ...(interesseId ? [{ field_id: FIELD.INTERESSE, values: [{ enum_id: interesseId }] }] : []),
    ];

    // ── Actualizar lead existente OU criar novo ───────────────────────────────
    if (existingContact?.leadId) {
      // Cliente recorrente: actualizar lead existente sem tocar em origem/pipeline
      await client.patch('/leads', [{
        id:   existingContact.leadId,
        name: formatLeadName(name, service, duration, location, normalizedPhone, bookingDate, bookingTime),
        price: getPrice(service, duration),
        custom_fields_values: bookingFields,
      }]);
      await moveLeadToStage(
        existingContact.leadId,
        'Agendado',
        {},
        existingContact.leadPipelineId || PIPELINE_ID,
      );
      logger.info('Lead existente actualizado no Kommo', { leadId: existingContact.leadId, contactId, name });
      return { leadId: existingContact.leadId, contactId };
    }

    // Novo lead — inclui campos de origem
    const leadRes = await client.post('/leads', [{
      name: formatLeadName(name, service, duration, location, normalizedPhone, bookingDate, bookingTime),
      price: getPrice(service, duration),
      pipeline_id: isReturningClient ? PIPELINE_ATIVOS : PIPELINE_ID,
      status_id:   isReturningClient ? STATUS_ATIVOS_AGENDADO : STATUS_AGENDADO,
      responsible_user_id: RESPONSIBLE_USER,
      _embedded: { contacts: [{ id: contactId }] },
      custom_fields_values: [
        ...bookingFields,
        { field_id: FIELD.TIPO_SESSAO,    values: [{ enum_id: mapTipoSessao(isReturningClient) }] },
        { field_id: FIELD.MOEDA,          values: [{ enum_id: ENUM.MOEDA_EUR }] },
        { field_id: FIELD.LEAD_ORIGEM,    values: [{ enum_id: leadOrigemId }] },
        { field_id: FIELD.LEAD_SUBORIGEM, values: [{ enum_id: leadSuborigemId }] },
        ...(conversationNotes ? [{ field_id: FIELD.NOTAS, values: [{ value: conversationNotes }] }] : []),
      ],
    }]);

    const leadId = leadRes.data?._embedded?.leads?.[0]?.id;
    logger.info('Novo lead criado no Kommo', { leadId, contactId, name, service, source });
    return { leadId, contactId };
  } catch (err) {
    logger.error('Kommo createOrUpdateLead falhou', err?.response?.data || err);
    return null;
  }
}

// ─── MOVER STAGE ──────────────────────────────────────────────────────────────

async function moveLeadToStage(leadId, stageName, extraFields = {}, pipelineId = PIPELINE_ID) {
  if (!SUBDOMAIN || !TOKEN || !leadId) return null;

  const isAtivos = pipelineId === PIPELINE_ATIVOS;
  const stages   = isAtivos ? STAGE.ativos : STAGE.principal;

  const tsMap = {
    Novo: FIELD.TS_NOVO, Agendado: FIELD.TS_AGENDADO, Confirmado: FIELD.TS_CONFIRMADO,
    Reagendar: FIELD.TS_REAGENDAR, Compareceu: FIELD.TS_COMPARECEU, 'No-show': FIELD.TS_NO_SHOW,
    Cancelado: FIELD.TS_CANCELADO, 'Nova Sessão': FIELD.TS_NOVA_SESSAO,
  };

  const stageMap = Object.fromEntries(
    Object.entries(stages).map(([name, status]) => [name, { status, timestampField: tsMap[name] }])
  );

  const stage = stageMap[stageName];
  if (!stage) { logger.warn('Stage desconhecido:', stageName); return null; }

  // Status do campo Agendamento (igual para ambos os pipelines)
  const statusEnumMap = {
    'Agendado': ENUM.STATUS_AGENDADO,
    'Reagendar': ENUM.STATUS_REAGENDAMENTO,
    'Cancelado': ENUM.STATUS_CANCELOU,
    'No-show':   ENUM.STATUS_NO_SHOW,
  };

  const customFields = [
    { field_id: stage.timestampField, values: [{ value: Math.floor(Date.now() / 1000) }] },
  ];
  if (statusEnumMap[stageName]) {
    customFields.push({ field_id: FIELD.STATUS, values: [{ enum_id: statusEnumMap[stageName] }] });
  }
  for (const [fieldId, value] of Object.entries(extraFields)) {
    customFields.push({ field_id: parseInt(fieldId), values: [{ value }] });
  }

  try {
    await client.patch('/leads', [{
      id:                   leadId,
      status_id:            parseInt(stage.status, 10),
      custom_fields_values: customFields,
    }]);
    logger.info('Lead movido para stage', { leadId, stage: stageName, pipeline: pipelineId });
    return true;
  } catch (err) {
    logger.error('Kommo moveLeadToStage falhou', err?.response?.data || err);
    return null;
  }
}

// ─── ACTUALIZAR CAMPOS ────────────────────────────────────────────────────────

async function updateLeadFields(leadId, fieldMap, isEnumMap = {}, leadName = null) {
  if (!SUBDOMAIN || !TOKEN || !leadId) return null;

  const customFields = [];
  for (const [fieldId, value] of Object.entries(fieldMap)) {
    if (value === null || value === undefined || value === '') continue;
    if (isEnumMap[fieldId]) {
      customFields.push({ field_id: parseInt(fieldId), values: [{ enum_id: value }] });
    } else {
      customFields.push({ field_id: parseInt(fieldId), values: [{ value }] });
    }
  }

  const payload = { id: leadId };
  if (customFields.length) payload.custom_fields_values = customFields;
  if (leadName)            payload.name = leadName;
  if (!customFields.length && !leadName) return null;

  try {
    await client.patch('/leads', [payload]);
    logger.info('Lead fields actualizados', { leadId, fields: Object.keys(fieldMap), nameUpdated: !!leadName });
    return true;
  } catch (err) {
    logger.error('Kommo updateLeadFields falhou', err?.response?.data || err);
    return null;
  }
}

async function addNote(leadId, text) {
  if (!SUBDOMAIN || !TOKEN || !leadId) return;
  try {
    await client.post('/leads/notes', [{
      entity_id: leadId,
      note_type: 'common',
      params: { text },
    }]);
  } catch (err) {
    logger.error('Kommo addNote falhou', err);
  }
}

// ─── MAPPINGS ─────────────────────────────────────────────────────────────────

function mapServiceToEnum(service, duration) {
  const s = (service || '').toLowerCase();
  if (s.includes('bliss')) return duration === 90 ? ENUM.PROCED_BLISS_90 : ENUM.PROCED_BLISS_60;
  if (s.includes('relax')) {
    if (duration === 30) return ENUM.PROCED_RELAX_30;
    if (duration === 90) return ENUM.PROCED_RELAX_90;
    return ENUM.PROCED_RELAX_60;
  }
  return null;
}

function mapTipoSessao(isReturningClient) {
  return isReturningClient ? ENUM.TIPO_ACOMPANHAMENTO : ENUM.TIPO_AVALIACAO;
}

function mapOrigemLead(contactOrigem, contactSuborigem) {
  const o = (contactOrigem || '').toLowerCase();
  if (o.includes('tráf') || o.includes('paid') || o.includes('c1') || o.includes('c2')) return ENUM.LEAD_ORIGEM_TRAFEGO_PAGO;
  if (o.includes('org')  || o.includes('website'))  return ENUM.LEAD_ORIGEM_ORGANICO;
  if (o.includes('indic'))                           return ENUM.LEAD_ORIGEM_INDICACAO;
  if (o.includes('telegram') || o.includes('pros'))  return ENUM.LEAD_ORIGEM_PROSPECCAO;
  return ENUM.LEAD_ORIGEM_TRAFEGO_PAGO;
}

function mapSuborigemLead(contactSuborigem) {
  const s = (contactSuborigem || '').toLowerCase();
  if (s.includes('c1'))        return ENUM.LEAD_SUB_C1;
  if (s.includes('c2'))        return ENUM.LEAD_SUB_C2;
  if (s.includes('facebook'))  return ENUM.LEAD_SUB_FB;
  if (s.includes('instagram')) return ENUM.LEAD_SUB_IG;
  if (s.includes('google'))    return ENUM.LEAD_SUB_GOOGLE;
  if (s.includes('website'))   return ENUM.LEAD_SUB_WEBSITE;
  return ENUM.LEAD_SUB_NAO;
}

function mapInterestToEnum(service, duration) {
  const s = (service || '').toLowerCase();
  if (s.includes('bliss')) return duration === 90 ? ENUM.INTERESSE_TERAPEUTICA_90 : ENUM.INTERESSE_TERAPEUTICA_60;
  if (s.includes('relax')) {
    if (s.includes('plano') || s.includes('mensal')) {
      if (duration === 30) return ENUM.INTERESSE_PLANO_RELAX_30;
      if (duration === 25) return ENUM.INTERESSE_PLANO_RELAX_25;
      if (duration === 90) return ENUM.INTERESSE_PLANO_RELAX_90;
      return ENUM.INTERESSE_PLANO_RELAX_60;
    }
    if (duration === 30) return ENUM.INTERESSE_EXPRESS_30;
    if (duration === 90) return ENUM.INTERESSE_RELAX_90;
    return ENUM.INTERESSE_RELAX_60;
  }
  if (s.includes('domicilio') || s.includes('domicílio')) return ENUM.INTERESSE_DOMICILIO;
  if (s.includes('visceral'))                              return ENUM.INTERESSE_VISCERAL_60;
  if (s.includes('quantum'))                               return ENUM.INTERESSE_QUANTUM_60;
  if (s.includes('terapeutica') || s.includes('terapêutica')) {
    return duration === 90 ? ENUM.INTERESSE_TERAPEUTICA_90 : ENUM.INTERESSE_TERAPEUTICA_60;
  }
  return null;
}

function mapLocationToEnum(location) {
  const l = (location || '').toLowerCase();
  if (l.includes('domicilio') || l.includes('domicílio')) return ENUM.LOCAL_DOMICILIO;
  if (l.includes('cascais'))                               return ENUM.LOCAL_CASCAIS;
  return ENUM.LOCAL_LISBOA;
}

function getPrice(service, duration) {
  const prices = { bliss: { 60: 60, 90: 75 }, relax: { 30: 35, 60: 45, 90: 60 } };
  const key    = (service || '').toLowerCase().includes('bliss') ? 'bliss' : 'relax';
  return prices[key]?.[duration] || 0;
}

function formatLeadName(name, service, duration, location, phone, bookingDate, bookingTime) {
  const serviceLabel   = service === 'bliss' ? 'Bliss Touch' : (service === 'relaxante' ? 'Relaxante' : service);
  const locationLabel  = location === 'Domicilio' ? 'Domicílio' : (location === 'Lisboa' ? 'Lisboa' : location);
  const priceLabel     = `${getPrice(service, duration)}€`;

  let dateTimeLabel = '';
  if (bookingDate && bookingTime) {
    const [y, m, d] = bookingDate.split('-');
    dateTimeLabel = `${d}/${m}/${y} ${bookingTime}`;
  } else if (bookingDate) {
    const [y, m, d] = bookingDate.split('-');
    dateTimeLabel = `${d}/${m}/${y}`;
  }

  return [serviceLabel, `${duration}min`, priceLabel, locationLabel, name, phone, dateTimeLabel]
    .filter(p => p)
    .join(' | ');
}

function extractCustomField(contact, fieldName) {
  const fields = contact.custom_fields_values || [];
  return fields.find(f => f.field_name === fieldName)?.values?.[0]?.value || null;
}

/**
 * Sincroniza um agendamento unificado com o Kommo.
 * Esta é a nova porta de entrada que respeita o "Contrato".
 */
async function syncBookingToKommo(booking, telegramId = null, extra = {}) {
  if (!booking) return null;

  const [bookingDate, bookingTimeFull] = booking.startTime.split('T');
  const bookingTime = bookingTimeFull.substring(0, 5); // HH:mm

  return createOrUpdateLead({
    name: booking.client.name,
    phone: booking.client.phone,
    email: booking.client.email,
    service: booking.service.name,
    duration: booking.service.duration,
    bookingUid: booking.id,
    bookingDate,
    bookingTime,
    telegramId,
    nif: booking.metadata?.nif,
    location: booking.metadata?.address ? 'Domicílio' : 'Consultório',
    ...extra
  });
}

module.exports = {
  findClientByPhone,
  findClientByTelegramId,
  findLeadByBookingUid,
  createOrUpdateLead,
  syncBookingToKommo, // Novo
  moveLeadToStage,
  updateLeadFields,
  addNote,
  formatLeadName,
  getPrice,
  ENUM,
  FIELD,
};
