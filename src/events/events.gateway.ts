import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';

// Gateway delgado: room por tenant. El worker del webhook emite message:new /
// message:status; la bandeja (feature 05) los consume.
@WebSocketGateway({ cors: true })
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer() private server!: Server;

  constructor(private readonly jwt: JwtService) {}

  // Handshake autenticado: el cliente pasa el JWT en auth.token; el tenant sale
  // del token, no de un query manipulable. Token inválido o ausente → se corta.
  async handleConnection(socket: Socket) {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) {
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
