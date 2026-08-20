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
import { Contexto, NOMBRE_VAR, interpolar, valorDe } from './contexto';
import { TOPE_MS, ejecutarCodigo } from './codigo';
import { ramaDeCondicion, ramaDeSwitch } from './comparadores';
import { TRIGGERS } from './triggers';

// --- Contrato ----------------------------------------------------------------------

export type TipoCampo = 'string' | 'texto' | 'number' | 'boolean' | 'json' | 'opcion' | 'codigo';

export interface Campo {
  tipo: TipoCampo;
  label: string;
  requerido?: boolean;
  opciones?: string[]; // solo para `opcion`
  ayuda?: string;
  /**
   * No sustituir `{{...}}` en este campo. La excepción, no la regla: todo lo demás se
   * interpola en un solo sitio (`interpolarConfig`), porque cuando era decisión de cada
   * handler la mitad de los campos se la saltaba y la pantalla no lo decía.
   */
  sinInterpolar?: boolean;
  /**
   * Con qué sintaxis se escribe una variable AQUÍ, para que el editor sugiera la correcta.
   * Solo hay que ponerlo en las excepciones; `modoRutas()` deriva el resto.
   */
  rutas?: ModoRutas;
}

/**
 * Las tres formas de nombrar una ruta del contexto, según el campo:
 * `llaves` → «Hola {{contacto.nombre}}» · `ctx` → `ctx.vars.total` dentro del código ·
 * `ruta` → el campo ES la ruta, sin adornos (el «Campo» de los nodos de lógica).
 */
export type ModoRutas = 'llaves' | 'ctx' | 'ruta';

/**
 * Qué sugerir en un campo. Se deriva en vez de anotarse en los doce campos de texto: la
 * regla es «todo campo de texto admite {{...}}», y las excepciones son las que se declaran.
 */
export function modoRutas(campo: Campo): ModoRutas | null {
  if (campo.rutas) return campo.rutas;
  if (campo.tipo === 'codigo') return 'ctx';
  if (campo.sinInterpolar) return null; // `guardarComo`: es un nombre, no una plantilla
  return campo.tipo === 'string' || campo.tipo === 'texto' ? 'llaves' : null;
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

/**
 * Techo de cualquier espera, en minutos (7 días). Vale para el «Esperar N minutos» y para la
 * caducidad del «Esperar respuesta»: por encima de una semana, un run aparcado deja de ser una
 * espera y es un olvido.
 */
export const TOPE_ESPERA_MIN = 7 * 24 * 60;

/**
 * La rama por la que sigue «Esperar respuesta» cuando el contacto no contesta a tiempo.
 *
 * El nombre está aquí y **copiado a mano en `canvas.ts` del frontend**, igual que la regex de
 * `{{...}}`: `ramasDe()` decide cuántos puertos se dibujan y tiene que coincidir con lo que
 * `siguienteNodoId` busca aquí. Si se cambia en un sitio y no en el otro, el operador cablea
 * una arista a una rama que el motor no mira nunca — y no da error, simplemente no pasa nada.
 */
export const RAMA_SIN_RESPUESTA = 'sin-respuesta';

/** Paciencia por defecto de «Esperar respuesta», en horas. El porqué del 24, en su `ayuda`. */
export const CADUCIDAD_RESPUESTA_H = 24;

export interface Salida {
  output?: unknown;
  /** Rama por la que seguir. `null` = la salida por defecto. */
  branch?: string | null;
  /**
   * Pedir al motor que espere: por tiempo (`ms`) o a que el cliente conteste (`entrada`).
   *
   * Con `entrada`, `caducaMs` dice cuánta paciencia tener. No es opcional de hecho: sin
   * caducidad, un cliente que no contesta nunca dejaba la conversación bloqueada para siempre.
   */
  esperar?: { ms?: number; entrada?: boolean; caducaMs?: number };
}

export interface NodeType {
  key: string;
  label: string;
  category: 'trigger' | 'accion' | 'logica';
  descripcion: string;
  configSchema: ConfigSchema;
  handler?: (config: any, ej: Ejecucion) => Promise<Salida>;
  /** No ofrecer «Guardar el resultado como»: este nodo no produce nada que nombrar. */
  sinSalida?: boolean;
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

// Ya NO interpola: el motor le entrega al handler la config con las `{{...}}` resueltas
// (`interpolarConfig`, abajo). Si esto volviera a llamar a `interpolar`, esos campos se
// sustituirían dos veces.
function texto(config: any, campo: string, _ej: Ejecucion): string {
  return String(config?.[campo] ?? '');
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
    label: 'Llega una llamada externa',
    category: 'trigger',
    descripcion:
      'Un sistema de fuera hace POST a una URL propia de esta automatización. El cuerpo del JSON queda en {{disparador.cuerpo...}}.',
    configSchema: {
      telefono: {
        tipo: 'string',
        label: 'Teléfono del contacto (opcional)',
        ayuda:
          'Admite {{disparador.cuerpo.telefono}}. Si ese contacto ya tiene una conversación abierta, el run la usa y ' +
          '«Enviar mensaje» funciona. NO crea contactos ni conversaciones: para escribir primero está la cartera de clientes.',
      },
    },
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
    key: 'var.set',
    label: 'Guardar una variable',
    category: 'accion',
    descripcion: 'Guarda un valor con nombre para reusarlo más adelante como {{vars.<nombre>}}.',
    configSchema: {
      // Declara `guardarComo` él mismo, y por eso `schemaDe` no se lo inyecta: aquí el
      // nombre es el punto del nodo, así que va obligatorio y con otra etiqueta. El
      // mecanismo que lo guarda es el mismo de todas las acciones — cero casos especiales
      // en el motor.
      guardarComo: { tipo: 'string', label: 'Nombre de la variable', requerido: true, sinInterpolar: true },
      valor: { tipo: 'texto', label: 'Valor', ayuda: 'Admite {{...}}' },
    },
    handler: async (config, ej) => ({ output: texto(config, 'valor', ej) }),
  },
  {
    key: 'code.run',
    label: 'Calcular con código',
    category: 'accion',
    descripcion: 'JavaScript que recibe `ctx` y devuelve un valor: totales, porcentajes, tarifas por tramo.',
    configSchema: {
      codigo: {
        tipo: 'codigo',
        label: 'Código',
        requerido: true,
        // Si se interpolara, el texto que escribe un cliente entraría DENTRO del programa y
        // podría cerrar una comilla y seguir programando. Aquí se leen ctx.vars.x directamente.
        sinInterpolar: true,
        ayuda: 'Recibes `ctx` (mensaje, contacto, vars, ajustes, nodos) y devuelves con `return`.',
      },
    },
    handler: async (config, ej) => {
      // El código NO se interpola con {{...}}, a diferencia del resto de campos de texto.
      // Si se hiciera, el texto que escribe un cliente entraría dentro del programa y podría
      // cerrar una comilla y seguir programando. Se leen `ctx.vars.x` y `ctx.ajustes.y`.
      const codigo = String(config?.codigo ?? '');
      return { output: await ejecutarCodigo(codigo, ej.contexto, TOPE_MS) };
    },
  },
  {
    key: 'http.request',
    label: 'Llamar a una API',
    category: 'accion',
    descripcion: 'GET o POST a una URL externa. Nómbrala en «Guardar el resultado como» y la respuesta se lee con {{vars.<nombre>.json...}}.',
    configSchema: {
      url: {
        tipo: 'string',
        label: 'URL',
        requerido: true,
        // Techo conocido: no hay defensa contra SSRF. Una variable en el HOST manda el fetch
        // del worker a donde diga el dato — y con el disparador de llamada externa ese dato
        // lo elige un tercero. Media defensa (un regex contra 169.254.) sería peor que
        // ninguna: da confianza y se salta con un DNS que resuelve a una IP privada.
        ayuda: 'No pongas variables en el dominio: solo en la ruta o los parámetros.',
      },
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
      // Techo de 7 días: por encima, lo que se quiere es un disparador por hora («a una hora»),
      // no un run aparcado un mes ocupando un job con `delay` en Redis. Sin techo, un
      // «43200 minutos» escrito por error era justo eso.
      const min = Math.min(Math.max(1, Number(config?.minutos) || 1), TOPE_ESPERA_MIN);
      return { esperar: { ms: min * 60_000 }, output: { minutos: min } };
    },
  },
  {
    key: 'wait.reply',
    label: 'Esperar respuesta',
    category: 'accion',
    descripcion:
      'Deja el run en espera hasta que el contacto conteste. Su respuesta llega en ' +
      '{{mensaje.texto}}. Si no contesta a tiempo, sigue por la rama «no contestó».',
    configSchema: {
      horas: {
        tipo: 'number',
        label: 'Horas de espera',
        ayuda:
          'Cuánto esperar antes de seguir por «no contestó». Por defecto 24, que es la ventana ' +
          'de servicio de WhatsApp: pasada, en el transporte oficial a menudo ya no se puede ' +
          'contestar, así que esperar más es esperar algo sobre lo que no se puede actuar.',
      },
    },
    // Su paso se registra ANTES de esperar, así que un «Guardar el resultado como» aquí
    // guardaría siempre null. La respuesta del cliente llega, como siempre, en
    // `{{mensaje.texto}}` (lo repone `trigger-on-inbound.ts` al reanudar).
    sinSalida: true,
    handler: async (config) => {
      const horas = Math.min(Math.max(1, Number(config?.horas) || CADUCIDAD_RESPUESTA_H), TOPE_ESPERA_MIN / 60);
      return { esperar: { entrada: true, caducaMs: horas * 3600_000 } };
    },
  },

  // ---- Lógica ---------------------------------------------------------------------
  {
    key: 'logic.condition',
    label: 'Si… entonces',
    category: 'logica',
    descripcion: 'Compara un campo del contexto y sigue por la rama verdadera o falsa.',
    configSchema: {
      campo: { tipo: 'string', label: 'Campo', requerido: true, rutas: 'ruta', ayuda: 'P. ej. mensaje.texto' },
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
      campo: { tipo: 'string', label: 'Campo', requerido: true, rutas: 'ruta' },
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
      campo: { tipo: 'string', label: 'Campo', requerido: true, rutas: 'ruta' },
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

// --- Nombrar la salida de un nodo --------------------------------------------------

export const GUARDAR_COMO: Campo = {
  tipo: 'string',
  // Es un nombre, no una plantilla (y `NOMBRE_VAR` ya prohíbe las llaves).
  sinInterpolar: true,
  label: 'Guardar el resultado como',
  ayuda: 'Un nombre corto; luego se lee como {{vars.<nombre>}} en cualquier nodo posterior.',
};

/**
 * El schema que se ENSEÑA y se VALIDA, que no es el que declara el nodo: a toda acción se le
 * añade «Guardar el resultado como».
 *
 * Existe porque `nodos.<id>` no sirve de cara al usuario. El id es un cuid, y además CAMBIA
 * en cada guardado del grafo (`guardarGrafo` borra y recrea las filas), así que un
 * `{{nodos.cmg7x2k9a0001.json.precio}}` escrito a mano deja de resolver al siguiente
 * guardado — y en silencio, porque una variable ausente se sustituye por vacío. La única
 * referencia estable a la salida de un nodo es el nombre que le ponga el operador.
 *
 * Se inyecta aquí, en un solo sitio, para que un tipo nuevo lo herede sin acordarse.
 */
export function schemaDe(tipo: NodeType): ConfigSchema {
  // Los de lógica solo producen la rama por la que sigue el run: no hay nada que nombrar.
  // Los triggers SÍ: su salida es la carga del disparo (`contexto.disparador`) — el texto que
  // arrancó el flujo, la palabra que coincidió o el cuerpo de la llamada externa.
  if (tipo.category === 'logica' || tipo.sinSalida) return tipo.configSchema;
  // Salvo que el nodo lo declare él mismo, para hacerlo obligatorio o renombrarlo (`var.set`).
  if (tipo.configSchema.guardarComo) return tipo.configSchema;
  return { ...tipo.configSchema, guardarComo: GUARDAR_COMO };
}

/**
 * Sustituye `{{...}}` en TODAS las cadenas de la config, incluidas las que van dentro de un
 * campo `json` (los `casos` de «Según el valor», si no, serían el último hueco). El motor la
 * llama justo antes del handler.
 *
 * Existe porque interpolar era decisión de cada handler, y eso dejaba once campos fuera sin
 * que la pantalla lo dijera — entre ellos el `valor` de «Si… entonces», que comparaba contra
 * el literal «{{vars.x}}» y por tanto se iba SIEMPRE por la rama falsa, en silencio.
 */
export function interpolarConfig(tipo: NodeType, config: unknown, ctx: Contexto): Record<string, unknown> {
  const src = (config ?? {}) as Record<string, unknown>;
  const schema = schemaDe(tipo);
  const hondo = (v: unknown): unknown => {
    if (typeof v === 'string') return interpolar(v, ctx);
    if (Array.isArray(v)) return v.map(hondo);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, hondo(x)]));
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [campo, valor] of Object.entries(src)) {
    out[campo] = schema[campo]?.sinInterpolar ? valor : hondo(valor);
  }
  return out;
}

const POR_KEY = new Map(NODE_TYPES.map((t) => [t.key, t]));

export function nodeType(key: string): NodeType | undefined {
  return POR_KEY.get(key);
}

/**
 * El catálogo tal como lo consume el editor: sin `handler` (que no es serializable) y con el
 * `configSchema` efectivo, así el panel pinta «Guardar el resultado como» sin saber que existe.
 */
export function catalogoPublico() {
  return NODE_TYPES.map(({ handler: _handler, ...resto }) => ({ ...resto, configSchema: schemaDe(resto as NodeType) }));
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

  for (const [campo, def] of Object.entries(schemaDe(tipo))) {
    const v = src[campo];
    const vacio = v === undefined || v === null || v === '';
    if (vacio) {
      if (def.requerido) throw new BadRequestException(`${tipo.label}: falta «${def.label}»`);
      continue;
    }
    switch (def.tipo) {
      case 'string':
      case 'texto':
      case 'codigo':
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

  // El nombre tiene que ser alcanzable desde `{{vars.<nombre>}}`. Un «mi total» o un «a.b»
  // se guardarían tan ricamente y luego no resolverían nunca, en silencio.
  const nombre = out.guardarComo;
  if (typeof nombre === 'string' && !NOMBRE_VAR.test(nombre)) {
    throw new BadRequestException(
      `${tipo.label}: «${nombre}» no vale como nombre de variable. Solo letras, números y guion bajo, empezando por letra.`,
    );
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
