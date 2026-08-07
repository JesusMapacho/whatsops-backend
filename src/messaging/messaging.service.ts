import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Platform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { EventsGateway } from '../events/events.gateway';
import {
  SendDto,
  isWithinWindow,
  storedTextPayload,
  templateBody,
} from './messaging.util';
import {
  isVoiceMime,
  uploadToGraph,
  validateMedia,
  withMediaUrl,
} from './media.util';
import { channelAdapter, ChannelAdapter } from './channels';
import {
  buildTemplateComponents,
  templateParams,
  unsupportedTemplateReason,
} from './template-params';
import {
  checkLimits,
  DAY_MS,
  HOUR_MS,
  isCold,
  LimitConfig,
  LimitVerdict,
  limitsFromEnv,
} from './limits';
import { coldWaId, openConversation, parsePhone, resolveContact } from './contact-resolve';
import { StorageService } from '../storage/storage.service';
import {
  checkNumberExists,
  fetchChatPictureUrl,
  sendReaction,
  sendSeen,
  setTyping,
} from '../waha/waha.client';
import { fetchPayloadBinary } from '../waha/waha.url';
import { applyReaction, REACTION_ME } from '../webhook/mutations';

// Archivo subido (forma mínima de multer; evita depender de @types/multer).
export interface UploadedMediaFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

// ponytail: versión de Graph fija con override por env (igual que waba.service).
const GRAPH_VERSION = 'v22.0';

// Mínimo entre dos "escribiendo…" de la misma conversación.
const TYPING_COOLDOWN_MS = 3000;


@Injectable()
export class MessagingService {
  private readonly graphVersion: string;
  // Base pública para que Meta (Messenger/IG) pueda descargar nuestro media por URL.
  // ponytail: en dev suele quedar vacío (Meta no alcanza localhost); el round-trip
  // real de media en esos canales se verifica en un entorno con URL pública.
  private readonly publicBaseUrl: string;
  // Instancia WAHA gestionada. Una conexión con `baseUrl` propio (BYO) la pisa.
  private readonly wahaUrl: string;
  private readonly limits: LimitConfig;
  // La feature entra APAGADA. Escribir a desconocidos arriesga el número del tenant
  // (y en la capa gratuita la reputación de la instancia compartida), así que se
  // enciende a conciencia por despliegue, no por defecto.
  private readonly coldEnabled: boolean;
  private readonly logger = new Logger(MessagingService.name);
  private readonly typingAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly events: EventsGateway,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.graphVersion = config.get<string>('GRAPH_API_VERSION') ?? GRAPH_VERSION;
    this.publicBaseUrl = config.get<string>('PUBLIC_BASE_URL') ?? '';
    this.wahaUrl = config.get<string>('WAHA_URL') ?? '';
    this.limits = limitsFromEnv((k) => config.get<string>(k));
    this.coldEnabled = config.get<string>('COLD_OUTREACH_ENABLED') === 'true';
  }

  async send(tenantId: string, conversationId: string, body: any) {
    const dto = parseSendDto(body);

    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { contact: true, wabaConnection: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');

    const adapter = channelAdapter(conv.platform);
    if (dto.type === 'template' && !adapter.supportsTemplate) {
      throw new BadRequestException('Este canal no soporta plantillas de Meta.');
    }
    // La plantilla se resuelve en el SERVIDOR: así se comprueba de paso que sigue
    // aprobada y que los valores cuadran, antes de gastar un envío.
    if (dto.type === 'template') dto.components = await this.templateComponents(tenantId, dto);
    // La ventana de 24 h es regla de Meta: WAHA (WhatsApp Web) no la tiene.
    if (dto.type === 'text' && adapter.enforcesWindow && !isWithinWindow(conv.lastInboundAt)) {
      throw new BadRequestException(adapter.windowClosedMessage);
    }
    await this.assertWithinLimits(adapter, tenantId, conv, conv.contact.isGroup);

    const token = this.crypto.decrypt(conv.wabaConnection.accessTokenEnc);
    const session = conv.wabaConnection.phoneNumberId;
    // `wire` = cuerpo que espera el proveedor (difiere por canal).
    // `stored` = lo que guardamos, SIEMPRE en la forma normalizada. Guardar el
    // cuerpo del proveedor dejaba `payload.text` como string en WAHA/Messenger, y
    // la bandeja lee `payload.text.body` → burbuja vacía, vista previa vacía y
    // búsqueda ciega. Además metía `session` en una columna que va al navegador.
    const wire = adapter.buildText(conv.contact.waId, dto, session);
    const stored = storedTextPayload(dto);
    const url = adapter.sendUrl(session, this.graphVersion, this.baseUrlFor(conv.wabaConnection));

    let res: Response;
    let json: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: adapter.authHeaders(token),
        body: JSON.stringify(wire),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      throw new BadRequestException('No se pudo contactar al proveedor de mensajería.');
    }

    if (!res.ok) {
      // Persistimos el saliente como failed para que la bandeja lo muestre.
      await this.persistFailed(tenantId, conversationId, dto.type, stored);
      throw new BadRequestException(adapter.mapError(json));
    }

    const message = await this.persistOutbound({
      tenantId,
      conversationId,
      direction: 'out',
      type: dto.type,
      payload: stored,
      wamid: this.messageIdOf(adapter, json),
      status: 'sent',
    });
    this.events.emitToTenant(tenantId, 'message:new', message);
    return message;
  }

  // Puerta ÚNICA de todo lo que escribe primero (uno a uno y masivo). Devuelve la
  // conexión validada; si algo no cuadra, lanza.
  //
  // Es un solo método a propósito: cuatro cerrojos duplicados en dos sitios acaban
  // divergiendo, y el que divergiría es justo el camino que le escribe a desconocidos.
  async assertColdAllowed(tenantId: string, body: any) {
    if (!this.coldEnabled) {
      throw new BadRequestException('Iniciar conversaciones está desactivado en este servidor.');
    }
    const connectionId = typeof body?.wabaConnectionId === 'string' ? body.wabaConnectionId : '';
    if (!connectionId) throw new BadRequestException('Elige desde qué número enviar.');
    // EL `tenantId` DE ESTE `where` ES LA FRONTERA. El id viene del formulario, así
    // que sin él un tenant podría enviar por el WhatsApp de otro.
    const conn = await this.prisma.wabaConnection.findFirst({
      where: { id: connectionId, tenantId },
    });
    if (!conn) throw new NotFoundException('Conexión no encontrada');

    const adapter = channelAdapter(conn.platform);
    if (!adapter.supportsColdOutreach) {
      throw new BadRequestException(
        'Este canal no permite iniciar conversación: su id no se puede derivar de un teléfono.',
      );
    }

    // El tenant tiene que haber aceptado el aviso una vez. Se comprueba en SERVIDOR
    // para que un script no pueda saltarse la pantalla.
    // ponytail: la aceptación viaja como `ack: true` en el primer envío en vez de
    // tener endpoint propio. El código de error es lo que dispara la pantalla.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { coldOutreachAckedAt: true },
    });
    if (!tenant?.coldOutreachAckedAt) {
      if (body?.ack !== true) throw new BadRequestException('COLD_OUTREACH_NOT_ACKED');
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { coldOutreachAckedAt: new Date() },
      });
    }
    return conn;
  }

  // waId definitivo de un número al que vamos a escribir por primera vez.
  //
  // Preguntar es mejor que construir: WAHA devuelve el chatId CANÓNICO, que resuelve
  // el 52/521 de México sin adivinar, y de paso dice si el número existe en WhatsApp
  // (enviar a números que no existen es de las señales de spam más fuertes).
  // `exists: null` = no se pudo comprobar; eso no bloquea.
  async coldWaIdFor(
    conn: { platform: Platform; baseUrl: string | null; phoneNumberId: string; accessTokenEnc: string },
    digits: string,
  ): Promise<{ waId: string; exists: boolean | null }> {
    const fallback = coldWaId(conn.platform, digits);
    if (conn.platform !== 'waha') return { waId: fallback, exists: null };
    const check = await checkNumberExists(
      conn.baseUrl ?? this.wahaUrl,
      this.crypto.decrypt(conn.accessTokenEnc),
      conn.phoneNumberId,
      digits,
    );
    if (!check) return { waId: fallback, exists: null };
    return { waId: check.chatId ?? fallback, exists: check.exists };
  }

  // Abre una conversación con un número que NUNCA nos ha escrito.
  //
  // No envía nada: deja la conversación lista y devuelve su id para que el flujo
  // normal de `send` haga el envío (y aplique ahí los topes en frío, la resolución de
  // plantilla y todo lo demás, sin duplicar reglas).
  async startConversation(tenantId: string, body: any) {
    const phone = parsePhone(body?.phone);
    if (!phone.ok) throw new BadRequestException(phone.reason);
    const conn = await this.assertColdAllowed(tenantId, body);

    const { waId, exists } = await this.coldWaIdFor(conn, phone.digits);
    if (exists === false) throw new BadRequestException('Ese número no tiene WhatsApp.');

    const contact = await resolveContact(this.prisma, {
      tenantId,
      platform: conn.platform,
      waId,
      phone: phone.digits,
      name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : null,
    });
    const conversation = await openConversation(this.prisma, {
      tenantId,
      platform: conn.platform,
      contactId: contact.id,
      wabaConnectionId: conn.id,
      // FRÍO: deja lastInboundAt en null, que es lo que obliga a Cloud a usar
      // plantilla y lo que hace que cuente para los topes de primer contacto.
      inbound: false,
    });
    this.events.emitToTenant(tenantId, 'conversation:updated', { id: conversation.id });
    return { id: conversation.id, contactId: contact.id, platform: conn.platform };
  }

  // Cuántos valores pide esta plantilla, comprobando de paso que existe, que sigue
  // APROBADA y que la soportamos. Para el envío masivo: validar el CSV contra la
  // plantilla en la SUBIDA es la diferencia entre "faltan valores, arregla la
  // columna" y 500 errores 132xxx, uno por destinatario.
  async templateParamCount(tenantId: string, name: string, language: string): Promise<number> {
    const tpl = await this.prisma.template.findUnique({
      where: { tenantId_name_language: { tenantId, name, language } },
    });
    if (!tpl) throw new BadRequestException('Esa plantilla no existe. Sincroniza las plantillas.');
    if (tpl.status !== 'APPROVED') {
      throw new BadRequestException(`La plantilla "${tpl.name}" ya no está aprobada por Meta.`);
    }
    const reason = unsupportedTemplateReason(tpl.components);
    if (reason) throw new BadRequestException(reason);
    return templateParams(tpl.components).length;
  }

  // Construye el `components` de la Cloud API a partir de los valores del operador.
  // `undefined` cuando la plantilla no lleva variables, para que el cuerpo omita la
  // clave (Meta la rechaza vacía).
  private async templateComponents(
    tenantId: string,
    dto: { name: string; language: string; params?: string[] },
  ): Promise<unknown[] | undefined> {
    const tpl = await this.prisma.template.findUnique({
      where: {
        tenantId_name_language: { tenantId, name: dto.name, language: dto.language },
      },
    });
    if (!tpl) throw new BadRequestException('Esa plantilla no existe. Sincroniza las plantillas.');
    // Meta puede haberla desaprobado desde el último sync; enviarla sería un 132xxx.
    if (tpl.status !== 'APPROVED') {
      throw new BadRequestException(`La plantilla "${tpl.name}" ya no está aprobada por Meta.`);
    }
    const reason = unsupportedTemplateReason(tpl.components);
    if (reason) throw new BadRequestException(reason);

    const params = templateParams(tpl.components);
    const values = dto.params ?? [];
    if (params.length !== values.length) {
      throw new BadRequestException(
        `La plantilla "${tpl.name}" necesita ${params.length} valores y se recibieron ${values.length}.`,
      );
    }
    if (values.some((v) => !v.trim())) {
      throw new BadRequestException('Ninguna variable de la plantilla puede ir vacía.');
    }
    const built = buildTemplateComponents(params, values);
    return built.length ? built : undefined;
  }

  // Guarda un saliente tolerando que el eco del proveedor (message.any) haya
  // creado ya la fila: WAHA emite el evento en milisegundos y el worker puede
  // ganarnos la carrera. Sin esto el `create` reventaría con P2002 y el agente
  // vería un 500 por un mensaje que SÍ se entregó (y al reintentar se duplica).
  private persistOutbound(data: {
    tenantId: string;
    conversationId: string;
    direction: 'out';
    type: string;
    payload: object;
    wamid: string | null;
    status: 'sent' | 'failed';
  }) {
    if (!data.wamid) return this.prisma.message.create({ data });
    const { tenantId, wamid } = data;
    return this.prisma.message.upsert({
      where: { tenantId_wamid: { tenantId, wamid } },
      create: data,
      // Nuestra versión manda: el eco guarda el payload crudo del proveedor.
      update: { payload: data.payload, status: data.status, type: data.type },
    });
  }

  // --- Acciones de conversación sobre WAHA -----------------------------------
  // Las tres comparten el mismo baile (resolver conversación → descifrar la key →
  // resolver baseUrl), así que vive una sola vez aquí. Devuelve null si la
  // conversación no es de WAHA: en los canales de Meta estas acciones no aplican.
  private async wahaCtx(tenantId: string, conversationId: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId, platform: 'waha' },
      include: { contact: true, wabaConnection: true },
    });
    if (!conv) return null;
    return {
      baseUrl: this.baseUrlFor(conv.wabaConnection),
      apiKey: this.crypto.decrypt(conv.wabaConnection.accessTokenEnc),
      session: conv.wabaConnection.phoneNumberId,
      chatId: conv.contact.waId,
    };
  }

  // Palomitas azules. Mejor esfuerzo: si falla, el agente ya leyó el mensaje igual.
  async markSeen(tenantId: string, conversationId: string) {
    const ctx = await this.wahaCtx(tenantId, conversationId);
    if (!ctx) return;
    await sendSeen(ctx.baseUrl, ctx.apiKey, ctx.session, ctx.chatId);
  }

  // Indicador "escribiendo…". WhatsApp no lo manda solo.
  //
  // El cooldown va en el SERVIDOR y no solo en el navegador: un cliente colgado o
  // un curl en bucle convertiría esto en llamadas de presencia sin límite sobre el
  // WhatsApp real del tenant, que es justo el riesgo de reputación que limits.ts
  // existe para evitar. No hay throttler global en el repo.
  // ponytail: Map en memoria; con varias réplicas cada una tiene su ventana.
  // Upgrade: contador en Redis (ya está ahí por BullMQ) si llega a importar.
  async setTyping(tenantId: string, conversationId: string, on: boolean) {
    if (on) {
      const last = this.typingAt.get(conversationId) ?? 0;
      if (Date.now() - last < TYPING_COOLDOWN_MS) return { skipped: true };
      this.typingAt.set(conversationId, Date.now());
    } else {
      this.typingAt.delete(conversationId);
    }
    const ctx = await this.wahaCtx(tenantId, conversationId);
    if (!ctx) return { skipped: true };
    await setTyping(ctx.baseUrl, ctx.apiKey, ctx.session, ctx.chatId, on);
    return { ok: true };
  }

  // Reacciona a un mensaje (emoji vacío = quitar).
  //
  // Se escribe también en nuestra copia al recibir 2xx: WAHA no manda webhook
  // fiable de tu PROPIA reacción en todos los engines, así que si no, el emoji
  // desaparecería al refrescar.
  async react(tenantId: string, conversationId: string, wamid: string, emoji: string) {
    const ctx = await this.wahaCtx(tenantId, conversationId);
    if (!ctx) throw new BadRequestException('Reaccionar solo está disponible en WhatsApp por QR.');
    const target = await this.prisma.message.findUnique({
      where: { tenantId_wamid: { tenantId, wamid } },
    });
    if (!target || target.conversationId !== conversationId) {
      throw new NotFoundException('Mensaje no encontrado');
    }

    try {
      await sendReaction(ctx.baseUrl, ctx.apiKey, ctx.session, wamid, emoji);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const payload = (target.payload ?? {}) as Record<string, unknown>;
    const updated = await this.prisma.message.update({
      where: { id: target.id },
      // El autor somos nosotros: se identifica con la sesión, que es estable y no
      // choca con los waId de los contactos.
      data: {
        payload: { ...payload, reactions: applyReaction(payload.reactions, REACTION_ME, emoji) },
      },
    });
    const withUrl = withMediaUrl(updated, (k) => this.storage.signedUrl(k));
    this.events.emitToTenant(tenantId, 'message:updated', withUrl);
    return withUrl;
  }

  // Foto de perfil del contacto de una conversación, en base64.
  //
  // Se sirve por proxy y NO se guarda en una columna ni en el storage: así no hay
  // que gestionar refresco, ni crecimiento de disco, ni el caso "la foto es null
  // mientras la sesión sincroniza" (la siguiente carga reintenta gratis).
  //
  // Va en base64 dentro del JSON, como el QR: un `<img src>` no puede mandar el
  // token de autenticación, así que un endpoint que devolviera la imagen cruda
  // tendría que ser público y firmado.
  //
  // ponytail: sin caché en servidor; el navegador la cachea por el Cache-Control que
  // pone el controlador y el frontend la pide una vez por conversación. Upgrade:
  // guardar la key en Contact si el tráfico llega a importar.
  async contactAvatar(tenantId: string, conversationId: string) {
    const ctx = await this.wahaCtx(tenantId, conversationId);
    if (!ctx) return null;
    const url = await fetchChatPictureUrl(ctx.baseUrl, ctx.apiKey, ctx.session, ctx.chatId).catch(
      () => null,
    );
    if (!url) return null;
    try {
      // La URL es de la CDN de WhatsApp (otro origen), así que se descarga SIN la
      // api key y solo si no apunta hacia dentro de la red. Y con tope de tamaño.
      const { buffer, mime } = await fetchPayloadBinary(url, ctx.baseUrl, ctx.apiKey);
      return { mimetype: mime, data: buffer.toString('base64') };
    } catch (e) {
      this.logger.warn(`No se pudo traer la foto de perfil: ${(e as Error).message}`);
      return null;
    }
  }

  // Base del proveedor: la propia de la conexión (BYO WAHA) o la instancia
  // gestionada de env. Vacío para Meta, que lleva el host en el adaptador.
  private baseUrlFor(conn: { baseUrl: string | null }): string {
    return conn.baseUrl ?? this.wahaUrl;
  }

  // Ritmo y cupo de la capa gratuita. Solo salientes y solo transportes `paced`
  // (WAHA): en los canales de Meta ya limita Meta.
  //
  // NUNCA se aplica a la recepción — cortar entrada perdería el mensaje de un
  // cliente final, que es justo lo que el producto promete no hacer.
  private async assertWithinLimits(
    adapter: ChannelAdapter,
    tenantId: string,
    conv: { id: string; contactId: string; lastInboundAt: Date | null },
    isGroup = false,
  ) {
    const cold = isCold(conv.lastInboundAt);
    // El ritmo *en caliente* sigue siendo solo de WAHA (en los canales de Meta ya
    // limita Meta). El cupo en FRÍO aplica a los dos transportes.
    if (!adapter.paced && !cold) return;
    try {
      const now = Date.now();
      const hourAgo = new Date(now - HOUR_MS);
      const dayAgo = new Date(now - DAY_MS);
      // Una conversación en frío que RECIBE respuesta deja de ser fría y sale de
      // estos conteos: quien acierta con su mensaje recupera cupo, y a quien nadie
      // contesta se le queda el tope pegado. Es la mejor señal disponible de "¿este
      // contacto era bienvenido?" y no cuesta una línea.
      const coldWhere = { tenantId, lastInboundAt: null, messages: { some: { direction: 'out' as const } } };
      const [contactLastHour, tenantLastDay, coldConversationOut, coldTenantHour, coldTenantDay, tenant] =
        await Promise.all([
          this.prisma.message.count({
            where: {
              tenantId,
              // Por CONTACTO, no por conversación: el worker abre una conversación
              // nueva cuando la anterior está cerrada, así que con el conteo por
              // conversación bastaba cerrar el hilo para resetear este tope.
              conversation: { contactId: conv.contactId },
              direction: 'out',
              createdAt: { gt: hourAgo },
              // El eco de lo que el dueño manda desde su teléfono NO cuenta: si
              // contara, cuatro respuestas rápidas desde el celular bloquearían al
              // agente con un 429.
              NOT: { payload: { path: ['viaDevice'], equals: true } },
            },
          }),
          this.prisma.message.count({
            where: { tenantId, direction: 'out', createdAt: { gt: dayAgo } },
          }),
          cold
            ? this.prisma.message.count({
                where: { tenantId, conversationId: conv.id, direction: 'out' },
              })
            : Promise.resolve(0),
          cold
            ? this.prisma.conversation.count({ where: { ...coldWhere, createdAt: { gt: hourAgo } } })
            : Promise.resolve(0),
          cold
            ? this.prisma.conversation.count({ where: { ...coldWhere, createdAt: { gt: dayAgo } } })
            : Promise.resolve(0),
          this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }),
        ]);
      const verdict = checkLimits(
        { contactLastHour, tenantLastDay, coldConversationOut, coldTenantHour, coldTenantDay },
        this.limits,
        tenant?.plan ?? 'free',
        { isGroup, cold },
      );
      if (!verdict.allowed) throw new HttpException(verdict.message, HttpStatus.TOO_MANY_REQUESTS);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      this.logger.warn(`No se pudo evaluar el cupo: ${(e as Error).message}`);
      // Fail-open SOLO en caliente: refusar la respuesta a un cliente que espera es
      // un fallo que él ve, y un mensaje de más no cuesta nada.
      //
      // En FRÍO se falla CERRADO, y por tres razones: nadie está esperando ese
      // mensaje, pasarse no tiene deshacer (un número baneado, una WABA con la
      // calidad por el suelo), y un contador que falla es justo el síntoma de la
      // ráfaga que queremos parar. 503 y no 429: es fallo NUESTRO, así el worker del
      // envío masivo reintenta en vez de marcar al destinatario como fallido.
      if (cold) {
        throw new HttpException(
          'No se pudo verificar el cupo de mensajes en frío. Inténtalo en un momento.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }
  }

  // ¿Cabe UNA conversación nueva en frío más? Para el envío masivo, que necesita el
  // veredicto ANTES de crear contacto y conversación: comprobarlo después dejaría
  // 480 conversaciones huérfanas cada vez que un envío se aborta por tope.
  //
  // `null` = no se pudo medir. Quien llama decide, y en frío la respuesta es parar
  // (ver decideRecipient): aquí nadie está esperando el mensaje.
  async coldQuota(tenantId: string): Promise<LimitVerdict | null> {
    try {
      const now = Date.now();
      // Una conversación en frío que RECIBE respuesta deja de ser fría y sale del
      // conteo: quien acierta con su mensaje recupera cupo en la hora.
      const coldWhere = {
        tenantId,
        lastInboundAt: null,
        messages: { some: { direction: 'out' as const } },
      };
      const [coldTenantHour, coldTenantDay, tenant] = await Promise.all([
        this.prisma.conversation.count({
          where: { ...coldWhere, createdAt: { gt: new Date(now - HOUR_MS) } },
        }),
        this.prisma.conversation.count({
          where: { ...coldWhere, createdAt: { gt: new Date(now - DAY_MS) } },
        }),
        this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }),
      ]);
      return checkLimits(
        // La conversación todavía no existe, así que no puede tener salientes.
        { contactLastHour: 0, tenantLastDay: 0, coldConversationOut: 0, coldTenantHour, coldTenantDay },
        this.limits,
        tenant?.plan ?? 'free',
        { cold: true },
      );
    } catch (e) {
      this.logger.warn(`No se pudo evaluar el cupo en frío: ${(e as Error).message}`);
      return null;
    }
  }

  // Id del mensaje según el proveedor: WAHA lo devuelve en la raíz, Meta en
  // `messages[0].id`. Sin esto los acuses de WAHA no encontrarían la fila.
  private messageIdOf(adapter: ChannelAdapter, json: any): string | null {
    if (!adapter.messageId) return json?.messages?.[0]?.id ?? null;
    const id = adapter.messageId(json);
    if (!id) {
      // Sin id no se puede deduplicar el eco ni casar los acuses. Se registran las
      // CLAVES de la respuesta (no el contenido) para poder añadir la forma que
      // falte sin tener que adivinar.
      this.logger.warn(
        `El proveedor no devolvió id de mensaje. Claves de la respuesta: ${Object.keys(
          json ?? {},
        ).join(', ')}`,
      );
    }
    return id;
  }

  // Envía un adjunto (imagen/documento/audio/video/sticker). El media de sesión
  // (no plantilla) respeta la ventana de 24 h igual que el texto.
  async sendMedia(
    tenantId: string,
    conversationId: string,
    file: UploadedMediaFile,
    caption?: string,
    replyTo?: string,
    durationSec?: number,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('Archivo requerido');

    // La conversación se carga ANTES de validar: los MIMEs permitidos dependen del
    // canal (WAHA transcodifica y acepta lo que graba el navegador).
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      include: { contact: true, wabaConnection: true },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    const adapter = channelAdapter(conv.platform);

    let kind;
    try {
      kind = validateMedia(file.mimetype, file.size, adapter.extraMimes);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    if (adapter.enforcesWindow && !isWithinWindow(conv.lastInboundAt)) {
      throw new BadRequestException(adapter.windowClosedMessage);
    }
    await this.assertWithinLimits(adapter, tenantId, conv, conv.contact.isGroup);

    const token = this.crypto.decrypt(conv.wabaConnection.accessTokenEnc);
    const filename = kind === 'document' ? file.originalname : undefined;
    // Guardamos una copia propia (para el hilo).
    const mediaKey = await this.storage.put(file.buffer, file.mimetype, filename);
    // Nota de voz vs audio adjunto: cambia el icono y el texto de la vista previa.
    const voice = kind === 'audio' && isVoiceMime(file.mimetype);
    const dbPayload = {
      kind,
      mediaKey,
      mimeType: file.mimetype,
      ...(filename ? { filename } : {}),
      ...(caption ? { caption } : {}),
      ...(voice ? { voice: true } : {}),
      // El webm del navegador no lleva cabecera de duración, así que el <audio> no
      // la puede mostrar: la mide el cliente al grabar y se guarda aquí.
      ...(voice && durationSec && Number.isFinite(durationSec)
        ? { durationSec: Math.round(durationSec) }
        : {}),
      ...(replyTo ? { replyToWamid: replyTo } : {}),
    };

    // WhatsApp: subir el binario a Meta y referenciar por media-id.
    // WAHA: inline en base64. Messenger/IG: URL pública de nuestro storage.
    let mediaRef: string;
    try {
      if (adapter.needsMediaUpload) {
        mediaRef = await uploadToGraph(
          token,
          this.graphVersion,
          conv.wabaConnection.phoneNumberId,
          file.buffer,
          file.mimetype,
          file.originalname,
        );
      } else if (adapter.mediaAsBase64) {
        // ponytail: inline evita depender de que el proveedor alcance una URL
        // nuestra (PUBLIC_BASE_URL suele estar vacío en dev, y desde el
        // contenedor de WAHA `localhost` es el propio contenedor).
        // Techo: duplica el binario en memoria. Upgrade: servir por URL firmada
        // con WAHA_MEDIA_BASE_URL apuntando al host.
        mediaRef = file.buffer.toString('base64');
      } else {
        mediaRef = `${this.publicBaseUrl}${this.storage.signedUrl(mediaKey)}`;
      }
    } catch (e) {
      await this.persistFailed(tenantId, conversationId, kind, dbPayload);
      throw new BadRequestException((e as Error).message);
    }

    const session = conv.wabaConnection.phoneNumberId;
    const graphBody = adapter.buildMedia(
      conv.contact.waId,
      kind,
      mediaRef,
      { caption, filename, mimeType: file.mimetype, replyTo },
      session,
    );
    const url = adapter.sendUrl(
      session,
      this.graphVersion,
      this.baseUrlFor(conv.wabaConnection),
      kind,
      // El mime decide la ruta: una nota de voz va por sendVoice, no por sendFile.
      file.mimetype,
    );

    let res: Response;
    let json: any;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: adapter.authHeaders(token),
        body: JSON.stringify(graphBody),
      });
      json = await res.json().catch(() => ({}));
    } catch {
      await this.persistFailed(tenantId, conversationId, kind, dbPayload);
      throw new BadRequestException('No se pudo contactar al proveedor de mensajería.');
    }

    if (!res.ok) {
      await this.persistFailed(tenantId, conversationId, kind, dbPayload);
      throw new BadRequestException(adapter.mapError(json));
    }

    const message = await this.persistOutbound({
      tenantId,
      conversationId,
      direction: 'out',
      type: kind,
      payload: dbPayload,
      wamid: this.messageIdOf(adapter, json),
      status: 'sent',
    });
    const withUrl = withMediaUrl(message, (k) => this.storage.signedUrl(k));
    this.events.emitToTenant(tenantId, 'message:new', withUrl);
    return withUrl;
  }

  private persistFailed(tenantId: string, conversationId: string, type: string, payload: object) {
    return this.prisma.message.create({
      data: { tenantId, conversationId, direction: 'out', type, payload, status: 'failed' },
    });
  }

  async syncTemplates(tenantId: string) {
    const conns = await this.prisma.wabaConnection.findMany({
      where: { tenantId, wabaId: { not: null } },
    });
    let synced = 0;
    for (const conn of conns) {
      const token = this.crypto.decrypt(conn.accessTokenEnc);
      const url = `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(
        conn.wabaId!,
      )}/message_templates?limit=100`;
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      } catch {
        throw new BadRequestException('No se pudo contactar a la Graph API de Meta');
      }
      if (!res.ok) continue; // una WABA sin permiso no rompe la sync de las demás
      const json: any = await res.json().catch(() => ({}));
      for (const t of json?.data ?? []) {
        if (!t?.name || !t?.language) continue;
        const data = {
          category: t.category ?? null,
          status: t.status ?? null,
          body: templateBody(t.components),
          // Crudo: es lo que permite reconstruir el cuerpo de envío con variables.
          components: t.components ?? null,
        };
        await this.prisma.template.upsert({
          where: {
            tenantId_name_language: { tenantId, name: t.name, language: t.language },
          },
          create: { tenantId, name: t.name, language: t.language, ...data },
          update: data,
        });
        synced++;
      }
    }
    return { synced };
  }

  async listTemplates(tenantId: string) {
    const rows = await this.prisma.template.findMany({
      where: { tenantId, status: 'APPROVED' },
      orderBy: { name: 'asc' },
    });
    // Los parámetros se derivan al LEER y no se guardan: `components` es la fuente
    // de verdad y una columna derivada se quedaría vieja tras un sync. La forma cruda
    // de Meta no sale de aquí: al navegador solo le llega la lista de parámetros.
    return rows.map(({ components, ...t }) => ({
      ...t,
      params: templateParams(components),
      unsupported: unsupportedTemplateReason(components),
    }));
  }
}

// Validación en la frontera de confianza: el body llega como `any` del cliente.
function parseSendDto(body: any): SendDto {
  // wamid del mensaje citado. Opcional en los dos tipos.
  const replyTo =
    typeof body?.replyTo === 'string' && body.replyTo.trim() ? body.replyTo.trim() : undefined;
  if (body?.type === 'template') {
    // `components` NO se acepta del cliente: la construye el servidor a partir de
    // `params`. Se ignora en silencio y no se lanza, para no romper a un cliente
    // viejo que todavía la mande.
    return {
      type: 'template',
      name: str(body?.name, 'name'),
      language: str(body?.language, 'language'),
      params: Array.isArray(body?.params) ? body.params.map((v: unknown) => String(v ?? '')) : [],
      ...(replyTo ? { replyTo } : {}),
    };
  }
  if (body?.type === 'text' || body?.text !== undefined) {
    return { type: 'text', text: str(body?.text, 'text'), ...(replyTo ? { replyTo } : {}) };
  }
  throw new BadRequestException('type debe ser "text" o "template"');
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new BadRequestException(`Campo requerido: ${field}`);
  }
  return v.trim();
}
