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

async function resolveAll(host: string): Promise<string[]> {
  try {
    const res = await lookup(host, { all: true });
    return res.map((r) => r.address);
  } catch {
    return [];
  }
}
