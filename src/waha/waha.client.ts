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
): Promise<void> {
  await deleteSession(baseUrl, apiKey, session).catch(() => undefined);
  const res = await call(baseUrl, apiKey, '/api/sessions', 'POST', {
    name: session,
    start: true,
    config: {
      webhooks: [{ url: webhookUrl, events: WAHA_EVENTS, hmac: { key: hmacKey } }],
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
): Promise<void> {
  if (!webhookUrl || !hmacKey) {
    throw new Error('Falta la URL de callback o el secreto HMAC: no se re-suscribe.');
  }
  const res = await call(baseUrl, apiKey, `/api/sessions/${encodeURIComponent(session)}`, 'PUT', {
    config: {
      webhooks: [{ url: webhookUrl, events: WAHA_EVENTS, hmac: { key: hmacKey } }],
    },
  });
  if (!res.ok) throw new Error('WAHA no pudo actualizar la config de la sesión.');
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
