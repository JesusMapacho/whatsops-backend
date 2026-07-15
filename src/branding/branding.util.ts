// Valida un color de acento entrante del cliente: hex #rrggbb (frontera de
// confianza; el valor termina en un CSS var del widget). Devuelve el hex en
// minúsculas o lanza. `null`/vacío = limpiar el override (volver al default).
export function parseAccentColor(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  throw new Error('accentColor debe ser un color hex #rrggbb');
}
