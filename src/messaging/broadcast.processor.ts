import { Processor, WorkerHost } from '@nestjs/bullmq';
import { BroadcastService, BROADCAST_QUEUE } from './broadcast.service';

// Worker del envío masivo. Un job RETRASADO por destinatario (el ritmo lo pone el
// `delay` de cada uno, no un sleep aquí dentro).
//
// `attempts: 1` en el módulo: reintentar un envío en frío es lo peor que se puede
// hacer. El POST pudo llegar y perderse la respuesta, y escribirle DOS VECES a un
// desconocido es literalmente lo que hace que te marquen como spam.
@Processor(BROADCAST_QUEUE)
export class BroadcastProcessor extends WorkerHost {
  constructor(private readonly broadcast: BroadcastService) {
    super();
  }

  process(job: { data: { recipientId: string } }) {
    return this.broadcast.processRecipient(job.data.recipientId);
  }
}
