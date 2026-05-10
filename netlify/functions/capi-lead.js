// Netlify Function: dispara evento Lead na Meta Conversions API (CAPI)
// Acionada por webhook do Netlify Forms ao receber um envio do form "auxilio-acidente"

const crypto = require('crypto');

const PIXEL_ID = '1503404940949685';
const META_API_VERSION = 'v18.0';

// SHA256 — Meta exige PII hasheado
function sha256(value) {
  if (!value) return undefined;
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

// Normaliza telefone brasileiro pra E.164 sem caracteres especiais
function normalizePhone(raw) {
  if (!raw) return undefined;
  const digits = String(raw).replace(/\D/g, '');
  // Se já começa com 55, usa direto. Se não, adiciona.
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  if (digits.length === 11 || digits.length === 10) return '55' + digits;
  return digits;
}

// Extrai primeiro e último nome separadamente
function splitName(fullName) {
  if (!fullName) return { first: undefined, last: undefined };
  const parts = String(fullName).trim().split(/\s+/);
  return {
    first: parts[0],
    last: parts.length > 1 ? parts[parts.length - 1] : undefined,
  };
}

exports.handler = async (event) => {
  // Netlify Forms manda POST com payload do form em JSON
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const accessToken = process.env.CAPI_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('CAPI_ACCESS_TOKEN não configurado nas env vars');
    return { statusCode: 500, body: 'Server config error' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    console.error('Body JSON inválido:', e.message);
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // Netlify Forms envia { payload: { data: {...}, ... } }
  const formData = payload?.payload?.data || payload?.data || payload;

  // Só processa o form de auxílio-acidente (segurança extra)
  const formName = payload?.payload?.form_name || payload?.form_name;
  if (formName && formName !== 'auxilio-acidente') {
    return { statusCode: 200, body: 'Ignored (other form)' };
  }

  const { first, last } = splitName(formData.nome);
  const phone = normalizePhone(formData.whatsapp);
  const eventId = formData.event_id || crypto.randomUUID();
  const eventTime = Math.floor(Date.now() / 1000);

  // IP e User Agent — Meta exige ao menos um
  const clientIp =
    event.headers['x-nf-client-connection-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0].trim() ||
    undefined;
  const userAgent = event.headers['user-agent'] || undefined;

  // Monta user_data com PII hasheado conforme spec da Meta
  const userData = {
    ph: phone ? [sha256(phone)] : undefined,
    fn: first ? [sha256(first)] : undefined,
    ln: last ? [sha256(last)] : undefined,
    client_ip_address: clientIp,
    client_user_agent: userAgent,
  };

  // Remove undefined pra não confundir a API
  Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);

  const body = {
    data: [
      {
        event_name: 'Lead',
        event_time: eventTime,
        event_id: eventId,
        action_source: 'website',
        event_source_url: 'https://aux-acidente.netlify.app/',
        user_data: userData,
        custom_data: {
          content_name: 'Auxilio-Acidente LP',
          content_category: 'Previdenciario',
          quando_acidente: formData.quando_aconteceu || undefined,
          recebeu_aux_doenca: formData.recebeu_auxilio_doenca || undefined,
        },
      },
    ],
  };

  const url = `https://graph.facebook.com/${META_API_VERSION}/${PIXEL_ID}/events?access_token=${accessToken}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Meta CAPI error:', result);
      return { statusCode: 502, body: JSON.stringify(result) };
    }

    console.log('CAPI Lead enviado:', { eventId, events_received: result.events_received });
    return { statusCode: 200, body: JSON.stringify({ ok: true, event_id: eventId, ...result }) };
  } catch (err) {
    console.error('Erro chamando Meta CAPI:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
