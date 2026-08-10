import { BadRequestException } from '@nestjs/common';

// Filtra los miembros de una cartera por la selección del operador. Puro (ver
// pick.check.ts).
//
// Vive aquí y no en un servicio porque lo usan el masivo y los estados: importarlo de uno
// al otro ataría dos servicios sin motivo.
//
// Sin selección se entienden TODOS: es lo que espera quien solo elige una cartera. Con
// selección, cada id tiene que ser miembro — un id que no lo sea es un intento de
// escribirle a alguien de FUERA de la cartera, y ese es justo el agujero que la cartera
// existe para cerrar. Se rechaza, no se ignora en silencio: ignorarlo dejaría al operador
// creyendo que envió a alguien a quien no envió.
export function pickSelected<T extends { id: string }>(miembros: T[], raw: unknown): T[] {
  const pedidos = normalizeIds(raw);
  if (!pedidos.length) return miembros;
  const porId = new Map(miembros.map((m) => [m.id, m]));
  const fuera = pedidos.filter((id) => !porId.has(id));
  if (fuera.length) {
    throw new BadRequestException('Hay destinatarios que no están en esa cartera.');
  }
  // Sin duplicados y en el orden en que llegaron.
  return [...new Set(pedidos)].map((id) => porId.get(id)!);
}

// Un formulario multipart manda una lista como campo repetido, y con un solo valor llega
// como string. Sin normalizar, seleccionar UNA persona se leería como "ninguna" y el
// envío saldría a toda la cartera.
export function normalizeIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v)).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}
