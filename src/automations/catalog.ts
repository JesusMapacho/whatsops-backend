// Catálogo de tipos de nodo (v3 feature 17). El corazón de "cualquier función de la app".
//
// Es CÓDIGO versionado y no filas por tenant, a propósito: si cada negocio tuviera su copia
// del catálogo, dos tenants acabarían con versiones distintas del mismo nodo y no habría
// forma de arreglar un bug en el de todos. Agregar una función a la app = registrar un tipo
// aquí; el motor no se toca.
//
// Cada acción **envuelve el servicio que ya existe** — nunca reimplementa. Es lo que hace
// que la ventana de 24 h, los topes anti-baneo, el alcance por rol y las reglas del CRM
// valgan igual desde una automatización que desde la pantalla.
import { BadRequestException } from '@nestjs/common';
import { Contexto, interpolar, valorDe } from './contexto';
import { ramaDeCondicion, ramaDeSwitch } from './comparadores';
import { TRIGGERS } from './triggers';

// --- Contrato ----------------------------------------------------------------------

export type TipoCampo = 'string' | 'texto' | 'number' | 'boolean' | 'json' | 'opcion';

export interface Campo {
  tipo: TipoCampo;
  label: string;
  requerido?: boolean;
  opciones?: string[]; // solo para `opcion`
  ayuda?: string;
}

export type ConfigSchema = Record<string, Campo>;

export interface Servicios {
  messaging: {
    send(tenantId: string, conversationId: string, body: any): Promise<any>;
    syncTemplates(tenantId: string): Promise<any>;
  };
  conversations: {
    assign(t: string, id: string, target: string | undefined, userId: string, role: string): Promise<any>;
    setStatus(t: string, id: string, status: unknown, userId: string, role: string): Promise<any>;
    // `body: string` y no `unknown` a propósito: escribir aquí la firma exacta del servicio
    // es lo que hace que el compilador atrape un handler que le pase la forma equivocada
    // (pasó con `{ body: texto }`, y el fallo solo se vio con un run a medio ejecutar).
    addNote(t: string, id: string, authorId: string, role: string, body: string): Promise<any>;
  };
  deals: {
    create(t: string, body: unknown, userId: string, role: string): Promise<any>;
    patch(t: string, id: string, body: unknown, userId: string, role: string): Promise<any>;
    setStatus(t: string, id: string, body: unknown, userId: string, role: string): Promise<any>;
  };
  tasks: {
    create(t: string, body: unknown, userId: string, role: string): Promise<any>;
  };
}

export interface Ejecucion {
  tenantId: string;
  /** El admin que activó la automatización. Null = lo borraron; los nodos que necesitan
   *  usuario fallan con un mensaje claro en vez de actuar como cualquiera. */
  actorUserId: string | null;
  conversationId: string | null;
  contexto: Contexto;
  servicios: Servicios;
}

export interface Salida {
  output?: unknown;
  /** Rama por la que seguir. `null` = la salida por defecto. */
  branch?: string | null;
  /** Pedir al motor que espere: por tiempo (`ms`) o a que el cliente conteste (`entrada`). */
  esperar?: { ms?: number; entrada?: boolean };
}

export interface NodeType {
  key: string;
  label: string;
  category: 'trigger' | 'accion' | 'logica';
  descripcion: string;
  configSchema: ConfigSchema;
  handler?: (config: any, ej: Ejecucion) => Promise<Salida>;
}

// --- Ayudas compartidas ------------------------------------------------------------

// El motor actúa con el rol de admin: no es un usuario navegando, es el servidor
// ejecutando lo que un admin dejó configurado. Quién puede CREAR la automatización ya lo
// filtró `automations:manage`.
const ROL = 'admin';

function actor(ej: Ejecucion): string {
  if (!ej.actorUserId) {
    throw new Error(
      'La automatización no tiene actor: el usuario que la activó ya no existe. Vuelve a activarla.',
    );
  }
  return ej.actorUserId;
}

function conversacion(ej: Ejecucion): string {
  if (!ej.conversationId) {
    throw new Error('Este nodo necesita una conversación y el run no tiene ninguna.');
  }
  return ej.conversationId;
}

function texto(config: any, campo: string, ej: Ejecucion): string {
  return interpolar(String(config?.[campo] ?? ''), ej.contexto);
}

// --- El catálogo -------------------------------------------------------------------

export const NODE_TYPES: NodeType[] = [
  // ---- Triggers (sin handler: no se ejecutan, deciden si el run nace) --------------
  {
    key: 'message.inbound',
    label: 'Entra un mensaje',
    category: 'trigger',
    descripcion: 'Cualquier mensaje entrante de un contacto (los grupos no cuentan).',
    configSchema: {},
  },
  {
    key: 'message.keyword',
    label: 'Entra un mensaje con una palabra',
    category: 'trigger',
    descripcion: 'Un entrante que contiene alguna de las palabras. Ignora mayúsculas y acentos.',
    configSchema: {
      palabras: { tipo: 'json', label: 'Palabras', requerido: true, ayuda: 'Lista, p. ej. ["precio","catalogo"]' },
    },
  },
  {
    key: 'webhook.received',
    label: 'Llega un evento del webhook',
    category: 'trigger',
    descripcion: 'Cualquier evento entrante del canal, con o sin texto.',
    configSchema: {},
  },
  {
    key: 'schedule.cron',
    label: 'A una hora',
    category: 'trigger',
    descripcion: 'Se dispara según un patrón cron (minuto hora día mes díaSemana).',
    configSchema: {
      patron: { tipo: 'string', label: 'Patrón cron', requerido: true, ayuda: 'P. ej. 0 9 * * 1 = lunes a las 9' },
    },
  },
  {
    key: 'manual',
    label: 'A mano',
    category: 'trigger',
    descripcion: 'Solo se dispara desde el botón o POST /automations/:id/run.',
    configSchema: {},
  },

  // ---- Acciones -------------------------------------------------------------------
  {
    key: 'message.send',
    label: 'Enviar mensaje',
    category: 'accion',
    descripcion:
      'Manda un texto por la conversación del run. Respeta la ventana de 24 h y los topes, porque usa el mismo envío que la bandeja.',
    configSchema: {
      texto: { tipo: 'texto', label: 'Texto', requerido: true, ayuda: 'Admite {{contacto.nombre}}' },
    },
    handler: async (config, ej) => {
      const body = { type: 'text', text: texto(config, 'texto', ej) };
      const msg = await ej.servicios.messaging.send(ej.tenantId, conversacion(ej), body);
      return { output: { wamid: msg?.wamid ?? null, id: msg?.id ?? null } };
    },
  },
  {
    key: 'conversation.assign',
    label: 'Asignar la conversación',
    category: 'accion',
    descripcion: 'Se la asigna a un agente. Sin usuario, la deja sin asignar.',
    configSchema: {
      userId: { tipo: 'string', label: 'Agente', ayuda: 'Vacío = quitar la asignación' },
    },
    handler: async (config, ej) => {
      const target = typeof config?.userId === 'string' && config.userId ? config.userId : undefined;
      await ej.servicios.conversations.assign(ej.tenantId, conversacion(ej), target, actor(ej), ROL);
      return { output: { assignedUserId: target ?? null } };
    },
  },
  {
    key: 'conversation.setStatus',
    label: 'Cambiar el estado de la conversación',
    category: 'accion',
    descripcion: 'Abierta, pendiente o cerrada.',
    configSchema: {
      status: { tipo: 'opcion', label: 'Estado', requerido: true, opciones: ['open', 'pending', 'closed'] },
    },
    handler: async (config, ej) => {
      await ej.servicios.conversations.setStatus(ej.tenantId, conversacion(ej), config?.status, actor(ej), ROL);
      return { output: { status: config?.status } };
    },
  },
  {
    key: 'conversation.addNote',
    label: 'Anotar en la conversación',
    category: 'accion',
    descripcion: 'Deja una nota interna. El cliente no la ve; sale en el timeline de la ficha.',
    configSchema: {
      texto: { tipo: 'texto', label: 'Nota', requerido: true },
    },
    handler: async (config, ej) => {
      // `addNote` recibe el texto suelto, no un objeto: es el mismo contrato que usa la
      // bandeja (`conversations.service.ts:193`).
      const nota = await ej.servicios.conversations.addNote(
        ej.tenantId,
        conversacion(ej),
        actor(ej),
        ROL,
        texto(config, 'texto', ej),
      );
      return { output: { id: nota?.id ?? null } };
    },
  },
  {
    key: 'handoff.human',
    label: 'Pasar a una persona',
    category: 'accion',
    descripcion:
      'Deja la conversación pendiente y, si se indica agente, se la asigna. Es el nodo que corta el automatismo y devuelve el turno al equipo.',
    configSchema: {
      userId: { tipo: 'string', label: 'Agente', ayuda: 'Vacío = la deja en la cola común' },
      nota: { tipo: 'texto', label: 'Nota para el equipo' },
    },
    handler: async (config, ej) => {
      const conv = conversacion(ej);
      await ej.servicios.conversations.setStatus(ej.tenantId, conv, 'pending', actor(ej), ROL);
      if (typeof config?.userId === 'string' && config.userId) {
        await ej.servicios.conversations.assign(ej.tenantId, conv, config.userId, actor(ej), ROL);
      }
      const nota = texto(config, 'nota', ej);
      if (nota) await ej.servicios.conversations.addNote(ej.tenantId, conv, actor(ej), ROL, nota);
      return { output: { handoff: true } };
    },
  },
  {
    key: 'templates.sync',
    label: 'Sincronizar plantillas',
    category: 'accion',
    descripcion: 'Reimporta las plantillas aprobadas desde Meta.',
    configSchema: {},
    handler: async (_config, ej) => ({ output: await ej.servicios.messaging.syncTemplates(ej.tenantId) }),
  },
  {
    key: 'deal.create',
    label: 'Crear trato',
    category: 'accion',
    descripcion: 'Crea un trato para el contacto del run, en la primera etapa o en la indicada.',
    configSchema: {
      titulo: { tipo: 'string', label: 'Título', ayuda: 'Vacío = el nombre del contacto' },
      pipelineId: { tipo: 'string', label: 'Embudo', ayuda: 'Vacío = el embudo por defecto' },
      stageId: { tipo: 'string', label: 'Etapa', ayuda: 'Vacío = la primera' },
      sinDueno: { tipo: 'boolean', label: 'Dejarlo sin dueño', ayuda: 'Así lo ve todo el equipo' },
    },
    handler: async (config, ej) => {
      const contactId = valorDe(ej.contexto, 'contacto.id');
      if (typeof contactId !== 'string' || !contactId) {
        throw new Error('Este nodo necesita el contacto del run.');
      }
      const deal = await ej.servicios.deals.create(
        ej.tenantId,
        {
          contactId,
          ...(texto(config, 'titulo', ej) ? { title: texto(config, 'titulo', ej) } : {}),
          ...(config?.pipelineId ? { pipelineId: config.pipelineId } : {}),
          ...(config?.stageId ? { stageId: config.stageId } : {}),
          ...(config?.sinDueno ? { ownerId: null } : {}),
        },
        actor(ej),
        ROL,
      );
      return { output: { id: deal?.id ?? null, title: deal?.title ?? null } };
    },
  },
  {
    key: 'deal.moveStage',
    label: 'Mover el trato de etapa',
    category: 'accion',
    descripcion: 'Mueve un trato a otra etapa, con su registro en el timeline y su tarea automática.',
    configSchema: {
      dealId: { tipo: 'string', label: 'Trato', requerido: true, ayuda: 'Admite {{nodos.<id>.id}}' },
      stageId: { tipo: 'string', label: 'Etapa destino', requerido: true },
    },
    handler: async (config, ej) => {
      const dealId = texto(config, 'dealId', ej);
      await ej.servicios.deals.patch(ej.tenantId, dealId, { stageId: config?.stageId }, actor(ej), ROL);
      return { output: { dealId, stageId: config?.stageId } };
    },
  },
  {
    key: 'deal.setStatus',
    label: 'Cerrar el trato',
    category: 'accion',
    descripcion: 'Ganado o perdido. Perdido exige motivo, igual que en el tablero.',
    configSchema: {
      dealId: { tipo: 'string', label: 'Trato', requerido: true },
      status: { tipo: 'opcion', label: 'Cierre', requerido: true, opciones: ['won', 'lost', 'open'] },
      lostReason: { tipo: 'string', label: 'Motivo (si se pierde)' },
    },
    handler: async (config, ej) => {
      const dealId = texto(config, 'dealId', ej);
      await ej.servicios.deals.setStatus(
        ej.tenantId,
        dealId,
        { status: config?.status, ...(config?.lostReason ? { lostReason: config.lostReason } : {}) },
        actor(ej),
        ROL,
      );
      return { output: { dealId, status: config?.status } };
    },
  },
  {
    key: 'task.create',
    label: 'Crear tarea',
    category: 'accion',
    descripcion: 'Una tarea de seguimiento con fecha, para el actor de la automatización o para quien se indique.',
    configSchema: {
      titulo: { tipo: 'string', label: 'Título', requerido: true },
      tipo: { tipo: 'opcion', label: 'Tipo', opciones: ['call', 'whatsapp', 'email', 'meeting', 'other'] },
      enDias: { tipo: 'number', label: 'Vence en (días)', ayuda: 'Por defecto, mañana' },
      assignedUserId: { tipo: 'string', label: 'Responsable', ayuda: 'Vacío = el actor de la automatización' },
    },
    handler: async (config, ej) => {
      const dias = Number.isFinite(Number(config?.enDias)) ? Number(config.enDias) : 1;
      // `dueDate` en YYYY-MM-DD y no un ISO completo: es lo que espera `parseTaskNueva`, que
      // compone la hora en la zona del negocio (`crm/tasks.query.ts`). Mandar un instante
      // desde aquí sería decidir la medianoche del servidor por el negocio.
      const vence = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
      const contactId = valorDe(ej.contexto, 'contacto.id');
      const tarea = await ej.servicios.tasks.create(
        ej.tenantId,
        {
          title: texto(config, 'titulo', ej),
          type: config?.tipo ?? 'call',
          dueDate: vence.toISOString().slice(0, 10),
          assignedUserId: config?.assignedUserId || actor(ej),
          ...(typeof contactId === 'string' && contactId ? { contactId } : {}),
        },
        actor(ej),
        ROL,
      );
      return { output: { id: tarea?.id ?? null } };
    },
  },
  {
    key: 'http.request',
    label: 'Llamar a una API',
    category: 'accion',
    descripcion: 'GET o POST a una URL externa. La respuesta queda en el contexto del run.',
    configSchema: {
      url: { tipo: 'string', label: 'URL', requerido: true },
      metodo: { tipo: 'opcion', label: 'Método', opciones: ['GET', 'POST'] },
      cuerpo: { tipo: 'texto', label: 'Cuerpo (JSON)', ayuda: 'Admite {{...}}' },
    },
    handler: async (config, ej) => {
      const url = texto(config, 'url', ej);
      if (!/^https?:\/\//i.test(url)) throw new Error('La URL tiene que empezar por http:// o https://');
      const metodo = config?.metodo === 'POST' ? 'POST' : 'GET';
      // Timeout obligatorio: sin él, una API ajena que no contesta se lleva por delante un
      // worker de la cola durante minutos.
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10_000);
      try {
        const res = await fetch(url, {
          method: metodo,
          signal: ac.signal,
          ...(metodo === 'POST'
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: texto(config, 'cuerpo', ej) || '{}',
              }
            : {}),
        });
        const cuerpo = await res.text();
        let json: unknown = null;
        try {
          json = JSON.parse(cuerpo);
        } catch {
          json = null;
        }
        // Se guarda un recorte: el contexto va a una columna Json que se lee entera en cada
        // paso, y una respuesta de 2 MB la arrastraría por todo el run.
        return { output: { status: res.status, ok: res.ok, json, texto: cuerpo.slice(0, 2000) } };
      } finally {
        clearTimeout(t);
      }
    },
  },
  {
    key: 'wait.delay',
    label: 'Esperar',
    category: 'accion',
    descripcion: 'Pausa el run y lo retoma pasado el tiempo indicado.',
    configSchema: {
      minutos: { tipo: 'number', label: 'Minutos', requerido: true },
    },
    handler: async (config) => {
      const min = Math.max(1, Number(config?.minutos) || 1);
      return { esperar: { ms: min * 60_000 }, output: { minutos: min } };
    },
  },
  {
    key: 'wait.reply',
    label: 'Esperar respuesta',
    category: 'accion',
    descripcion: 'Deja el run en espera hasta que el contacto conteste.',
    configSchema: {},
    handler: async () => ({ esperar: { entrada: true } }),
  },

  // ---- Lógica ---------------------------------------------------------------------
  {
    key: 'logic.condition',
    label: 'Si… entonces',
    category: 'logica',
    descripcion: 'Compara un campo del contexto y sigue por la rama verdadera o falsa.',
    configSchema: {
      campo: { tipo: 'string', label: 'Campo', requerido: true, ayuda: 'P. ej. mensaje.texto' },
      operador: { tipo: 'opcion', label: 'Operador', requerido: true, opciones: ['eq', 'neq', 'contains', 'gt', 'lt', 'matches'] },
      valor: { tipo: 'string', label: 'Valor' },
    },
    handler: async (config, ej) => {
      const rama = ramaDeCondicion(config ?? {}, ej.contexto);
      return { branch: rama, output: { rama } };
    },
  },
  {
    key: 'logic.switch',
    label: 'Según el valor',
    category: 'logica',
    descripcion: 'Varias ramas por el mismo campo. Si ninguna coincide, sigue por la salida por defecto.',
    configSchema: {
      campo: { tipo: 'string', label: 'Campo', requerido: true },
      casos: { tipo: 'json', label: 'Casos', requerido: true, ayuda: '[{"rama":"vip","operador":"eq","valor":"si"}]' },
    },
    handler: async (config, ej) => {
      const rama = ramaDeSwitch(config ?? {}, ej.contexto);
      return { branch: rama, output: { rama } };
    },
  },
  {
    key: 'logic.filter',
    label: 'Seguir solo si',
    category: 'logica',
    descripcion: 'Corta el run cuando la condición no se cumple. Es el «solo si» sin dibujar dos ramas.',
    configSchema: {
      campo: { tipo: 'string', label: 'Campo', requerido: true },
      operador: { tipo: 'opcion', label: 'Operador', requerido: true, opciones: ['eq', 'neq', 'contains', 'gt', 'lt', 'matches'] },
      valor: { tipo: 'string', label: 'Valor' },
    },
    handler: async (config, ej) => {
      const pasa = ramaDeCondicion(config ?? {}, ej.contexto) === 'true';
      // `branch: 'stop'` no existe como arista: el motor no encuentra salida y cierra el
      // run como hecho. Un filtro que no pasa no es un fallo.
      return { branch: pasa ? null : 'stop', output: { pasa } };
    },
  },
];

const POR_KEY = new Map(NODE_TYPES.map((t) => [t.key, t]));

export function nodeType(key: string): NodeType | undefined {
  return POR_KEY.get(key);
}

/** El catálogo tal como lo consume el editor: sin `handler`, que no es serializable. */
export function catalogoPublico() {
  return NODE_TYPES.map(({ handler: _handler, ...resto }) => resto);
}

/**
 * Valida la config de un nodo contra su `configSchema`. Se llama al guardar (frontera HTTP)
 * y no en el motor: descubrir en mitad de un run que a un nodo le falta un campo es
 * descubrirlo con un cliente esperando.
 */
export function validarConfig(key: string, config: unknown): Record<string, unknown> {
  const tipo = nodeType(key);
  if (!tipo) throw new BadRequestException(`Tipo de nodo desconocido: ${key}`);
  const src = (config ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [campo, def] of Object.entries(tipo.configSchema)) {
    const v = src[campo];
    const vacio = v === undefined || v === null || v === '';
    if (vacio) {
      if (def.requerido) throw new BadRequestException(`${tipo.label}: falta «${def.label}»`);
      continue;
    }
    switch (def.tipo) {
      case 'string':
      case 'texto':
        if (typeof v !== 'string') throw new BadRequestException(`${tipo.label}: «${def.label}» tiene que ser texto`);
        out[campo] = v;
        break;
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new BadRequestException(`${tipo.label}: «${def.label}» tiene que ser un número`);
        out[campo] = n;
        break;
      }
      case 'boolean':
        out[campo] = v === true || v === 'true';
        break;
      case 'opcion':
        if (!def.opciones?.includes(String(v))) {
          throw new BadRequestException(
            `${tipo.label}: «${def.label}» tiene que ser uno de ${def.opciones?.join(', ')}`,
          );
        }
        out[campo] = String(v);
        break;
      case 'json':
        if (typeof v !== 'object') throw new BadRequestException(`${tipo.label}: «${def.label}» tiene que ser una lista o un objeto`);
        out[campo] = v as object;
        break;
    }
  }
  return out;
}

/** Valida el trigger de una automatización con el mismo camino que la config de un nodo. */
export function validarTrigger(raw: unknown): { type: string; config: Record<string, unknown> } {
  const t = (raw ?? {}) as Record<string, unknown>;
  const type = typeof t.type === 'string' ? t.type : '';
  if (!(TRIGGERS as readonly string[]).includes(type)) {
    throw new BadRequestException(`Disparador desconocido: ${type || '(vacío)'}`);
  }
  return { type, config: validarConfig(type, t.config) };
}
