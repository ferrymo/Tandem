import type pg from 'pg';
import { DomainError } from '@tandem/core';
import type {
  AvailableDeliveryChannel,
  DeliveryFence,
  DeliveryModelChannels,
  ResourceScope,
  RuntimeDeliveryChannel,
} from '@tandem/core';
import { withScope } from './index';

export class PostgresDeliveryModelChannels implements DeliveryModelChannels {
  constructor(private readonly pool: pg.Pool) {}
  available(scope: ResourceScope): Promise<AvailableDeliveryChannel[]> {
    return withScope(this.pool, scope, async (client) => {
      const result = await client.query(
        'SELECT * FROM tandem.wm_available_model_channels()',
      );
      return result.rows;
    });
  }
  async resolve(
    fence: DeliveryFence,
    reference: string,
  ): Promise<RuntimeDeliveryChannel> {
    try {
      const result = await this.pool.query(
        'SELECT tandem.delivery_model_channel($1,$2,$3,$4) AS value',
        [fence.job.id, fence.job.token, fence.workerId, reference],
      );
      if (!result.rows[0]?.value)
        throw new DomainError('FORBIDDEN', '运行的模型授权已失效');
      return result.rows[0].value;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code =
        error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code === '42501')
        throw new DomainError(
          'FORBIDDEN',
          '运行租约、账号或模型渠道授权已失效',
        );
      if (code === '22023' || code === '22P02')
        throw new DomainError(
          'UNAVAILABLE',
          '模型渠道已停用、版本已修改或凭证未配置，请重新选择渠道后启动新运行',
        );
      throw error;
    }
  }
}
