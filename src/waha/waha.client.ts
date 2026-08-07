// Cliente fino de la API de WAHA (https://waha.devlike.pro/docs/how-to/sessions/).
// Funciones planas, no un provider de Nest: no tiene estado ni dependencias.
// La api key NUNCA se loguea ni se devuelve al llamante.
import { WAHA_EVENTS } from '../webhook/waha';

function url(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function headers(apiKey: string): Record<string, string> {
  return { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' };
}

async function call(
  baseUrl: string,
  apiKey: string,
  path: string,
  method: string,
  body?: object,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url(baseUrl, path), {
      method,
      headers: headers(apiKey),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // Sin detalle del error de red: podría llevar la URL con credenciales.
    throw new Error('No se pudo contactar la instancia de WAHA.');
  }
  return res;
}

// Comprueba que la instancia responde y la api key sirve, antes de guardar nada.
export async function ping(baseUrl: string, apiKey: string): Promise<void> {
  const res = await call(baseUrl, apiKey, '/api/sessions', 'GET');
  if (res.status === 401 || res.status === 403) {
    throw new Error('La instancia de WAHA rechazó la api key.');
  }
  if (!res.ok) throw new Error('La instancia de WAHA no respondió correctamente.');
}

// Estado real de una sesión en la instancia. `me` solo viene si está emparejada.
export interface WahaSession {
  name: string;
  status: string;
  me: { id: string; pushName?: string } | null;
  // Config tal como la tiene la instancia. Se conserva CRUDA porque hay que
  // re-enviarla intacta al actualizar el webhook: el PUT reemplaza `config` entero,
  // y perder el bloque `noweb` significaría cambiar el store de una sesión ya
  // emparejada, que segun la doc de WAHA puede costar el historial del chat.
  config: any;
}

// Store del engine NOWEB. Sin él, WAHA no puede listar chats ni leer mensajes
// anteriores (`/chats`, `/chats/{id}/messages`, `/contacts/all`), así que sin esto
// no hay import de historial ni asunto de grupo.
//
// OJO: la doc advierte de NO cambiar estos valores después de escanear el QR — se
// puede perder el historial. Por eso solo se ponen al CREAR la sesión, y una sesión
// vieja necesita re-emparejarse para tenerlo.
export function nowebStoreConfig(fullSync: boolean) {
  return { noweb: { store: { enabled: true, fullSync } } };
}

// Fuente de verdad para la reconciliación: qué sesiones existen de verdad y en
// qué estado. `ping` no sirve porque descarta el cuerpo.
export async function listSessions(baseUrl: string, apiKey: string): Promise<WahaSession[]> {
  const res = await call(baseUrl, apiKey, '/api/sessions?all=true', 'GET');
  if (res.status === 401 || res.status === 403) {
    throw new Error('La instancia de WAHA rechazó la api key.');
  }
  if (!res.ok) throw new Error('La instancia de WAHA no respondió correctamente.');
  const json: any = await res.json().catch(() => null);
  if (!Array.isArray(json)) throw new Error('Respuesta inesperada de WAHA al listar sesiones.');
  return json
    .filter((s: any) => typeof s?.name === 'string')
    .map((s: any) => ({
      name: s.name,
      status: typeof s.status === 'string' ? s.status : 'UNKNOWN',
      me: s?.me?.id ? { id: s.me.id, pushName: s.me.pushName ?? undefined } : null,
      config: s?.config ?? null,
    }));
}

// Crea (o recrea) la sesión ya arrancada, con su webhook y su HMAC derivado.
// Borra antes: un POST sobre una sesión existente da 422, y recrear garantiza
// que el emparejamiento arranca limpio.
export async function createSession(
  baseUrl: string,
  apiKey: string,
  session: string,
  webhookUrl: string,
  hmacKey: string,
  fullSync = false,
): Promise<void> {
  await deleteSession(baseUrl, apiKey, session).catch(() => undefined);
  const res = await call(baseUrl, apiKey, '/api/sessions', 'POST', {
    name: session,
    start: true,
    config: {
      webhooks: [{ url: webhookUrl, events: WAHA_EVENTS, hmac: { key: hmacKey } }],
      // El store se fija AQUÍ y nunca después: cambiarlo con la sesión ya
      // emparejada puede costar el historial.
      ...nowebStoreConfig(fullSync),
    },
  });
  if (!res.ok) {
    const json: any = await res.json().catch(() => ({}));
    const m = json?.message;
    throw new Error(
      (Array.isArray(m) ? m.join('; ') : m) ?? 'WAHA no pudo crear la sesión.',
    );
  }
}

// Re-suscribe los eventos de una sesión YA emparejada. `PUT` reemplaza
// `config.webhooks` entero, así que hay que re-enviar la URL y la clave HMAC: sin
// el hmac, todo webhook posterior falla la firma → 401 → inbound perdido en
// silencio. Ojo: el PUT reinicia la sesión (no la desempareja).
export async function updateSessionWebhook(
  baseUrl: string,
  apiKey: string,
  session: string,
  webhookUrl: string,
  hmacKey: string,
  // Config actual de la sesión en la instancia. TODO lo que no sean webhooks se
  // re-envía tal cual: el PUT reemplaza `config` entero, así que omitir el bloque
  // `noweb` equivaldría a cambiar el store de una sesión ya emparejada — y eso,
  // según la doc de WAHA, puede costar el historial del chat.
  currentConfig?: any,
): Promise<void> {
  if (!webhookUrl || !hmacKey) {
    throw new Error('Falta la URL de callback o el secreto HMAC: no se re-suscribe.');
  }
  const { webhooks: _drop, ...preserved } = currentConfig ?? {};
  const res = await call(baseUrl, apiKey, `/api/sessions/${encodeURIComponent(session)}`, 'PUT', {
    config: {
      ...preserved,
      webhooks: [{ url: webhookUrl, events: WAHA_EVENTS, hmac: { key: hmacKey } }],
    },
  });
  if (!res.ok) throw new Error('WAHA no pudo actualizar la config de la sesión.');
}

// ¿Tiene esta sesión el store de NOWEB activo? Sin él no hay historial ni asunto
// de grupo, y no se puede activar sin re-emparejar.
export function hasStore(config: any): boolean {
  return config?.noweb?.store?.enabled === true;
}

// Asunto de un grupo. No requiere el store (viene del protocolo), pero puede fallar
// si la sesión no está lista: quien llama lo trata como opcional.
export async function getGroupSubject(
  baseUrl: string,
  apiKey: string,
  session: string,
  groupId: string,
): Promise<string | null> {
  const res = await call(
    baseUrl,
    apiKey,
    `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}`,
    'GET',
  );
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  const subject = json?.subject ?? json?.name;
  return typeof subject === 'string' && subject.trim() ? subject.trim() : null;
}

// Pide a WhatsApp un código de 8 dígitos para emparejar sin escanear.
//
// El código llega en la RESPUESTA, no por webhook. Nunca se loguea ni se guarda: es
// una credencial de un solo uso para vincular un dispositivo.
export async function requestPairingCode(
  baseUrl: string,
  apiKey: string,
  session: string,
  phone: string,
): Promise<string> {
  const res = await call(
    baseUrl,
    apiKey,
    `/api/${encodeURIComponent(session)}/auth/request-code`,
    'POST',
    { phoneNumber: phone },
  );
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = json?.message;
    // El soporte varía por engine: se muestra el motivo en vez de reventar.
    throw new Error(
      (Array.isArray(m) ? m.join('; ') : m) ??
        'WAHA no pudo pedir el código. Puede que este engine no lo soporte.',
    );
  }
  const code = json?.code ?? json?.pairingCode;
  if (typeof code !== 'string' || !code) throw new Error('WAHA no devolvió ningún código.');
  return code;
}

// ¿Existe este número en WhatsApp?
//
// Enviar a números que NO existen es una de las señales de spam masivo más fuertes:
// es literalmente lo que hace un bot recorriendo rangos. De paso WAHA devuelve el
// chatId CANÓNICO, que es mejor que cualquiera que construyamos nosotros (resuelve
// el problema del 52/521 en México sin adivinar).
//
// `null` = no se pudo comprobar. En un envío masivo eso se salta, no se arriesga.
export async function checkNumberExists(
  baseUrl: string,
  apiKey: string,
  session: string,
  phone: string,
): Promise<{ exists: boolean; chatId: string | null } | null> {
  const res = await call(
    baseUrl,
    apiKey,
    `/api/contacts/check-exists?phone=${encodeURIComponent(phone)}&session=${encodeURIComponent(session)}`,
    'GET',
  ).catch(() => null);
  if (!res?.ok) return null;
  const json: any = await res.json().catch(() => null);
  if (!json || typeof json.numberExists !== 'boolean') return null;
  return {
    exists: json.numberExists,
    chatId: typeof json.chatId === 'string' && json.chatId ? json.chatId : null,
  };
}

// Foto de perfil de un chat. Devuelve la URL que da WAHA (puede ser null si no hay
// foto o la sesión aún sincroniza).
export async function fetchChatPictureUrl(
  baseUrl: string,
  apiKey: string,
  session: string,
  chatId: string,
): Promise<string | null> {
  const res = await call(
    baseUrl,
    apiKey,
    `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/picture`,
    'GET',
  );
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  return typeof json?.url === 'string' && json.url ? json.url : null;
}

// Mensajes anteriores de un chat. EXIGE el store del engine NOWEB.
// `downloadMedia=false` a propósito: importar binarios de meses de historial es
// desproporcionado; esos mensajes quedan sin adjunto.
export async function fetchChatMessages(
  baseUrl: string,
  apiKey: string,
  session: string,
  chatId: string,
  limit: number,
  offset: number,
): Promise<any[]> {
  const res = await call(
    baseUrl,
    apiKey,
    `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages` +
      `?limit=${limit}&offset=${offset}&downloadMedia=false`,
    'GET',
  );
  if (!res.ok) {
    const json: any = await res.json().catch(() => ({}));
    // WAHA responde 400 con un mensaje explícito cuando falta el store.
    const m = typeof json?.message === 'string' ? json.message : '';
    if (/store/i.test(m)) {
      throw new Error(
        'Esta sesión no tiene el historial habilitado. Vuelve a conectar el número para activarlo.',
      );
    }
    throw new Error('WAHA no pudo leer los mensajes anteriores.');
  }
  const json: any = await res.json().catch(() => null);
  return Array.isArray(json) ? json : [];
}

export async function deleteSession(
  baseUrl: string,
  apiKey: string,
  session: string,
): Promise<void> {
  const res = await call(
    baseUrl,
    apiKey,
    `/api/sessions/${encodeURIComponent(session)}`,
    'DELETE',
  );
  // 404 = ya no existe: para borrar, es el resultado deseado.
  if (!res.ok && res.status !== 404) {
    throw new Error('WAHA no pudo borrar la sesión.');
  }
}

export async function restartSession(
  baseUrl: string,
  apiKey: string,
  session: string,
): Promise<void> {
  const res = await call(
    baseUrl,
    apiKey,
    `/api/sessions/${encodeURIComponent(session)}/restart`,
    'POST',
  );
  if (!res.ok) throw new Error('WAHA no pudo reiniciar la sesión.');
}

// --- Acciones sobre una conversación ---------------------------------------
// Todas son "mejor esfuerzo": si fallan, el mensaje ya se envió o se leyó igual.
// Por eso lanzan y quien llama decide (normalmente ignorar y loguear).

// Palomitas azules en el teléfono del cliente.
export async function sendSeen(
  baseUrl: string,
  apiKey: string,
  session: string,
  chatId: string,
): Promise<void> {
  const res = await call(baseUrl, apiKey, '/api/sendSeen', 'POST', { session, chatId });
  if (!res.ok) throw new Error('WAHA no pudo marcar como leído.');
}

// Indicador "escribiendo…". WhatsApp NO lo manda solo: hay que emitirlo.
export async function setTyping(
  baseUrl: string,
  apiKey: string,
  session: string,
  chatId: string,
  on: boolean,
): Promise<void> {
  const path = on ? '/api/startTyping' : '/api/stopTyping';
  const res = await call(baseUrl, apiKey, path, 'POST', { session, chatId });
  if (!res.ok) throw new Error('WAHA no pudo actualizar el indicador de escritura.');
}

// Reaccionar a un mensaje. Cadena vacía = quitar la reacción. Ojo: es PUT.
export async function sendReaction(
  baseUrl: string,
  apiKey: string,
  session: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const res = await call(baseUrl, apiKey, '/api/reaction', 'PUT', {
    session,
    messageId,
    reaction: emoji,
  });
  if (!res.ok) {
    const json: any = await res.json().catch(() => ({}));
    const m = json?.message;
    throw new Error((Array.isArray(m) ? m.join('; ') : m) ?? 'WAHA rechazó la reacción.');
  }
}

// Trae el QR de emparejamiento y lo devuelve ya en base64, para que el frontend
// lo pinte como data: URI sin plumbing de Blob ni negociar formatos con WAHA.
export async function fetchQr(
  baseUrl: string,
  apiKey: string,
  session: string,
): Promise<{ mimetype: string; data: string }> {
  const res = await call(
    baseUrl,
    apiKey,
    `/api/${encodeURIComponent(session)}/auth/qr`,
    'GET',
  );
  if (!res.ok) {
    // Pasa cuando la sesión ya está emparejada (WORKING) o aún arrancando.
    throw new Error('El QR no está disponible en este momento.');
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    mimetype: res.headers.get('content-type') ?? 'image/png',
    data: buffer.toString('base64'),
  };
}
