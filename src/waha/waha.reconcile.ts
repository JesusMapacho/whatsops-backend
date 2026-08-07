// Decisión pura de reconciliación de sesiones WAHA: qué hacer con una conexión
// dado su estado en la DB, su estado real en la instancia y si el tenant está
// suspendido. Sin DB ni fetch → testeable en aislamiento (waha.reconcile.check.ts).
//
// Por qué existe: el `status` de la fila solo se actualiza cuando llega un webhook
// `session.status`. Si la sesión muere callada (o el webhook se pierde), la fila
// se queda mintiendo `WORKING` y el tenant deja de recibir sin saberlo.

// Estado que ponemos cuando la sesión ya no existe en la instancia: la UI lo
// traduce a "vuelve a emparejar" y el gauge lo cuenta aparte.
export const MISSING = 'MISSING';

// La sesión existe pero murió y un reinicio NO la recuperó: el estado de auth ya
// no sirve (número desvinculado desde el teléfono, credenciales invalidadas por
// otra sesión con el mismo número…). Solo lo arregla volver a escanear el QR.
export const NEEDS_PAIRING = 'NEEDS_PAIRING';

export type ReconcileAction =
  | { kind: 'none' }
  // Actualizar el status de la fila al real de la instancia.
  | { kind: 'update'; status: string }
  // La sesión murió: reiniciarla y reflejar el estado.
  | { kind: 'restart'; status: string }
  // Borrar la sesión en la instancia (tenant suspendido, o sesión huérfana).
  | { kind: 'delete'; reason: 'suspended' | 'orphan' };

export interface ConnState {
  status: string;
  tenantSuspended: boolean;
}

// Estados de los que una sesión no sale sola: hay que reiniciarla.
const DEAD = new Set(['FAILED', 'STOPPED']);

// Decide para UNA conexión de la DB. `remote` = estado en la instancia, o null si
// la sesión no existe ahí.
export function decideForConnection(conn: ConnState, remote: string | null): ReconcileAction {
  // Un tenant suspendido no debe seguir operando. Borrar la sesión es la palanca
  // real: `Tenant.status` solo se verifica en el login, así que sin esto un
  // suspendido sigue emparejado recibiendo mensajes hasta que expire su JWT.
  if (conn.tenantSuspended) {
    return remote === null ? { kind: 'none' } : { kind: 'delete', reason: 'suspended' };
  }

  // La sesión ya no existe en la instancia. NO la recreamos: haría falta volver a
  // escanear el QR igualmente, así que solo lo marcamos para que la UI lo pida.
  if (remote === null) {
    return conn.status === MISSING ? { kind: 'none' } : { kind: 'update', status: MISSING };
  }

  if (DEAD.has(remote)) {
    // UN solo reinicio por episodio de caída. La primera vez que la vemos muerta
    // se reinicia y se anota el estado; si en la pasada siguiente SIGUE muerta, el
    // reinicio no sirvió y hay que re-emparejar.
    //
    // Reintentar sin tope no arreglaría nada y martillearía la reconexión contra
    // los servidores de WhatsApp cada pasada, que es justo el patrón por el que
    // marcan un número — lo contrario de lo que protege esta feature.
    if (conn.status === NEEDS_PAIRING) return { kind: 'none' };
    if (DEAD.has(conn.status)) return { kind: 'update', status: NEEDS_PAIRING };
    return { kind: 'restart', status: remote };
  }

  return remote === conn.status ? { kind: 'none' } : { kind: 'update', status: remote };
}

// Estados en los que tiene sentido re-suscribir el webhook. Nunca sobre una sesión
// que no existe o está detenida: el PUT la arrancaría o fallaría sin motivo.
const RESUBSCRIBABLE = new Set(['WORKING', 'SCAN_QR_CODE']);

// ¿Hay que re-suscribir los eventos de esta conexión?
//
// Se decide por un ENTERO de versión, no comparando la lista de eventos contra la
// que reporta WAHA. Motivo: `PUT /api/sessions/{name}` reinicia la sesión, así que
// si WAHA devolviera los eventos reordenados, deduplicados o con defaults propios,
// una comparación que nunca converge reiniciaría TODAS las sesiones de la flota en
// cada pasada — desemparejadas y sin un solo error visible. Con un entero es
// idempotente sin importar qué reporte la instancia.
export function webhookNeedsUpdate(
  rowVersion: number,
  wantedVersion: number,
  remoteStatus: string | null,
): boolean {
  if (rowVersion >= wantedVersion) return false;
  return !!remoteStatus && RESUBSCRIBABLE.has(remoteStatus);
}

// Sesiones que existen en la instancia pero no tienen fila: gastan RAM y mandan
// webhooks que no resuelven a ningún tenant (y cada uno acaba en `failed` tras los
// reintentos). Solo se tocan las que llevan nuestro prefijo, para no borrar
// sesiones ajenas si la instancia se comparte con otra cosa.
export function orphanSessions(remoteNames: string[], knownNames: string[]): string[] {
  const known = new Set(knownNames);
  return remoteNames.filter((n) => n.startsWith('t_') && !known.has(n));
}
