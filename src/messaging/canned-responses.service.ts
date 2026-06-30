import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CannedResponsesService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string) {
    return this.prisma.cannedResponse.findMany({
      where: { tenantId },
      orderBy: { title: 'asc' },
    });
  }

  async create(tenantId: string, body: any) {
    const title = str(body?.title, 'title');
    const text = str(body?.body, 'body');
    try {
      return await this.prisma.cannedResponse.create({
        data: { tenantId, title, body: text },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('Ya existe una respuesta con ese título');
      throw e;
    }
  }

  async remove(tenantId: string, id: string) {
    const { count } = await this.prisma.cannedResponse.deleteMany({ where: { id, tenantId } });
    if (!count) throw new NotFoundException('Respuesta rápida no encontrada');
    return { deleted: true };
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new BadRequestException(`Campo requerido: ${field}`);
  }
  return v.trim();
}
