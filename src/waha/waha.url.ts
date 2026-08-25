// Guarda anti-SSRF para el `baseUrl` de una instancia WAHA propia del tenant (BYO).
//
// Por qué hace falta: la URL la elige el tenant y el backend la consulta y
// **devuelve el cuerpo al llamante** (endpoint del QR). Sin este filtro, un admin
// de cualquier tenant apunta baseUrl a 169.254.169.254 y convierte /qr en un
// lector de credenciales de metadata de la nube.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Rangos que nunca son una instancia WAHA legítima de internet.
// Se comparan sobre la forma numérica, no como texto.
function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // privada
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 168) return true; // privada
  if (a === 169 && b === 254) return true; // link-local → metadata de la nube
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reservado
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::' || v === '::1') return true; // sin especificar / loopback
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (/^f[cd]/.test(v)) return true; // fc00::/7 unique-local
  // IPv4 mapeada (::ffff:10.0.0.1) → decidir por la parte v4.
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) return isPrivateIpv6(ip);
  return isPrivateIpv4(ip);
}

// Valida el baseUrl y lo devuelve normalizado (sin barra final). Lanza Error con
// mensaje accionable si no sirve.
//
// ponytail: se resuelve el DNS una vez aquí; queda una ventana TOCTOU (el nombre
// podría re-resolver a una IP privada al hacer el fetch). Techo aceptado para BYO.
// Upgrade: fijar la IP validada al conectar, o salir por un proxy de egreso con
// allowlist.
export async function assertSafeBaseUrl(raw: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('La URL de WAHA no es válida.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('La URL de WAHA debe ser http o https.');
  }
  if (u.username || u.password) {
    throw new Error('La URL de WAHA no debe llevar credenciales.');
  }

  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await resolveAll(host));
  if (!ips.length) throw new Error('No se pudo resolver el host de WAHA.');
  if (ips.some(isPrivateIp)) {
    throw new Error('La URL de WAHA apunta a una dirección interna o reservada.');
  }
  return `${u.protocol}//${u.host}`;
}

// Reescribe una URL de media de WAHA sobre NUESTRA base conocida, conservando solo
// la ruta y la query.
//
// Por qué: WAHA genera la URL con su propia vista de sí mismo (dentro del
// contenedor, `localhost:3000`), que no coincide con el `baseUrl` con el que
// nosotros la alcanzamos (`127.0.0.1:3002`). Comparar orígenes rechazaba media
// legítima; y confiar en el host del payload es justo el agujero que hay que evitar.
//
// Tomando solo la ruta se consiguen las dos cosas: funciona, y el host del payload
// deja de importar — nunca seguimos a donde nos diga un tercero.
//
// Pero pinear el host no basta, y esta es la parte que faltaba: la RUTA seguía viniendo del
// payload, y `fetchPayloadBinary` le adjunta la api key por ser mismo origen. Un
// `media.url` con ruta `/api/sessions` convertía esto en un GET autenticado a la API de
// WAHA cuya respuesta se guarda como adjunto legible en la bandeja — o sea el config de
// todas las sesiones, claves HMAC incluidas. De ahí el prefijo: WAHA sirve los binarios
// bajo /api/files/, y nada más de su API se parece a un archivo.
const RUTA_DE_ARCHIVOS = '/api/files/';

export function wahaMediaUrl(payloadUrl: string, baseUrl: string): string | null {
  if (!baseUrl) return null;
  try {
    const u = new URL(payloadUrl);
    const base = new URL(baseUrl);
    // `pathname` ya viene normalizado por `URL` (los `..` y los `%2e` resueltos), así que
    // esto no se puede burlar con un travesía relativa.
    if (!u.pathname.startsWith(RUTA_DE_ARCHIVOS)) return null;
    return `${base.origin}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

// Tope de un binario descargado de una URL del payload. Coincide con el límite de
// documento de la Cloud API; lo que exceda no lo íbamos a poder reenviar igual.
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

// Descarga un binario de una URL del payload, con las dos protecciones que
// necesita: origen validado (ver assertSafeFetchUrl) y TAMAÑO ACOTADO.
//
// El tope importa: `arrayBuffer()` sobre una URL que elige un tercero es una lectura
// de memoria sin límite dentro del worker — un archivo enorme lo tumba.
export async function fetchPayloadBinary(
  url: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ buffer: Buffer; mime: string }> {
  const { withKey } = await assertSafeFetchUrl(url, baseUrl);
  const res = await fetch(url, {
    headers: withKey ? { 'X-Api-Key': apiKey } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // Si el servidor declara el tamaño, se rechaza antes de leer un solo byte.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error('El adjunto excede el tamaño máximo.');
  }

  const mime = res.headers.get('content-type') ?? 'application/octet-stream';
  if (!res.body) throw new Error('Respuesta sin cuerpo.');

  // Lectura por trozos para poder cortar aunque no haya content-length (o mienta).
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = (res.body as any).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('El adjunto excede el tamaño máximo.');
    }
    chunks.push(Buffer.from(value));
  }
  return { buffer: Buffer.concat(chunks), mime };
}

// ¿Se le puede adjuntar la api key a esta URL?
//
// Por qué existe: las URLs de media y de foto de perfil vienen DENTRO del payload
// del webhook o de la respuesta de la instancia, o sea que las controla quien opera
// esa instancia. Con BYO eso es el tenant. Si se adjuntara la api key a cualquier
// URL, un tenant podría apuntarla a un endpoint de metadata de la nube o a un
// servicio interno y recibir la respuesta con una credencial nuestra encima.
//
// Regla: la key SOLO viaja al mismo origen que la instancia. Una CDN legítima de
// WhatsApp (pps.whatsapp.net, mmg.whatsapp.net) es otro origen y no la necesita.
export function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

// Comprueba que una URL del payload es segura de descargar. Devuelve si hay que
// adjuntar la api key. Lanza si no se debe tocar en absoluto.
export async function assertSafeFetchUrl(
  url: string,
  baseUrl: string,
): Promise<{ withKey: boolean }> {
  // Mismo origen que la instancia: es ella misma sirviendo el binario.
  if (baseUrl && sameOrigin(url, baseUrl)) return { withKey: true };

  // Otro origen: se descarga SIN credencial y solo si no apunta hacia dentro.
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('URL de media inválida.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('URL de media con esquema no permitido.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : await resolveAll(host);
  if (!ips.length) throw new Error('No se pudo resolver el host del media.');
  if (ips.some(isPrivateIp)) {
    throw new Error('La URL del media apunta a una dirección interna o reservada.');
  }
  return { withKey: false };
}

/**
 * Guarda anti-SSRF para una URL de salida cualquiera, sin `baseUrl` de por medio: la usa el
 * sondeo de APIs de la feature 47, donde la URL la teclea un admin y el backend **devuelve el
 * cuerpo al llamante**, que es la misma forma que hace peligroso el `/qr` de arriba.
 *
 * Vive en este archivo y no en `automations/` a propósito: la lista de rangos privados ya está
 * aquí, y un tercer sitio con la misma lista es cómo se acaba con dos definiciones de
 * «privado» — la que se actualiza y la que no.
 *
 * Hereda el techo de TOCTOU que `assertSafeBaseUrl` ya nombra: entre resolver y llamar, el
 * nombre puede re-resolver a una privada. No se vuelve a argumentar aquí; reargumentarlo
 * invitaría a creer que se resolvió.
 *
 * NO cubre las redirecciones: un 302 hacia 169.254.169.254 se salta todo esto. Quien llame
 * tiene que pedir `redirect: 'manual'` — está en el check.
 *
 * Se valida el host **que sale del parseo**, no el texto que llegó, y eso no es un detalle: un
 * valor interpolado dentro de la URL puede llevar una `@` y correr el host entero
 * (`https://algo@otro.com/` tiene host `otro.com`). Comparar contra la cadena original
 * validaría un host que el `fetch` no va a usar. Por eso `catalog.ts` pide además no meter
 * variables en el dominio: aquí se está a salvo, pero allí se está adivinando a quién se llama.
 */
export async function assertSafeOutboundUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('La URL no es válida.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Solo se puede llamar por http:// o https://.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : await resolveAll(host);
  if (!ips.length) throw new Error(`No se pudo resolver el host «${host}».`);
  if (ips.some(isPrivateIp)) {
    throw new Error('Esa URL apunta a una dirección interna o reservada.');
  }
  return u;
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    const res = await lookup(host, { all: true });
    return res.map((r) => r.address);
  } catch {
    return [];
  }
}
