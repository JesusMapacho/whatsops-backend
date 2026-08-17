import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { corsOriginCheck } from '../config/cors';
import { SESSION_COOKIE, readCookie } from '../auth/session-cookie';

// Gateway delgado: room por tenant. El worker del webhook emite message:new /
// message:status; la bandeja (feature 05) los consume.
//
// `credentials: true` no es adorno: sin él el navegador no manda la cookie en el
// handshake y todas las conexiones se caen con el token ausente.
@WebSocketGateway({ cors: { origin: corsOriginCheck, credentials: true } })
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer() private server!: Server;

  constructor(private readonly jwt: JwtService) {}

  // Handshake autenticado por la cookie de sesión (v6 feature 31): el cliente ya no pasa
  // nada en `auth.token` porque no tiene acceso al token. El tenant sale del JWT, no de un
  // query manipulable. Cookie inválida o ausente → se corta.
  async handleConnection(socket: Socket) {
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    if (!token) {
      socket.disconnect();
      return;
    }
    try {
      const payload = await this.jwt.verifyAsync(token);
      socket.join(`tenant:${payload.tenantId}`);
    } catch {
      socket.disconnect();
    }
  }

  emitToTenant(tenantId: string, event: string, payload: unknown) {
    this.server.to(`tenant:${tenantId}`).emit(event, payload);
  }
}
