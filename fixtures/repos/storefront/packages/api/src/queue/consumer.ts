import { retriesLeft } from '@storefront/shared';
import type { ZodType, ZodTypeDef } from 'zod';

export interface Envelope {
  body: unknown;
  retries: string;
}

/** Validates each message against its schema before the handler sees it. */
export class QueueConsumer<TMessage> {
  constructor(
    private readonly schema: ZodType<TMessage, ZodTypeDef, unknown>,
    private readonly handle: (message: TMessage) => Promise<void>,
  ) {}

  async receive(envelope: Envelope): Promise<'done' | 'retry' | 'dead'> {
    const parsed = this.schema.safeParse(envelope.body);
    if (!parsed.success) return retriesLeft(envelope.retries) > 0 ? 'retry' : 'dead';
    await this.handle(parsed.data);
    return 'done';
  }
}
