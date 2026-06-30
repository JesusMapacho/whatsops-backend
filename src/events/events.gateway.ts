import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

// Gateway delgado: room por tenant. El worker del webhook emite message:new /
// message:status; la bandeja (feature 05) los consume.
// ponytail: sin auth JWT aún; el tenantId llega por el handshake. La feature 05
// autentica el handshake con el JWT y deja de confiar en este query param.
@WebSocketGateway({ cors: true })
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer() private server!: Server;

  handleConnection(socket: Socket) {
    const tenantId = socket.handshake.auth?.tenantId ?? socket.handshake.query?.tenantId;
    if (typeof tenantId === 'string' && tenantId) {
      socket.join(`tenant:${tenantId}`);
    }
  }

  emitToTenant(tenantId: string, event: string, payload: unknown) {
    this.server.to(`tenant:${tenantId}`).emit(event, payload);
  }
}
