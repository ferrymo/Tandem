import { DomainError } from './index';
import type { WorkModelChannel } from './work-management';
import type { DeliveryFence } from './delivery';

export type DeliveryChannelModel = {
  channelId: string;
  version: number;
  model: string;
};
export function parseDeliveryChannelModel(
  value: string,
): DeliveryChannelModel | null {
  if (!value.startsWith('channel:')) return null;
  const match =
    /^channel:([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}):([1-9]\d{0,9}):(.{1,200})$/i.exec(
      value,
    );
  if (
    !match ||
    !Number.isSafeInteger(Number(match[2])) ||
    Number(match[2]) > 2147483647
  )
    throw new DomainError('INVALID_INPUT', '模型渠道引用无效，请重新选择模型');
  return { channelId: match[1]!, version: Number(match[2]), model: match[3]! };
}
export function formatDeliveryChannelModel(
  id: string,
  version: number,
  model: string,
): string {
  const value = `channel:${id}:${version}:${model}`;
  parseDeliveryChannelModel(value);
  return value;
}
export function displayDeliveryModel(value: string): string {
  try {
    return parseDeliveryChannelModel(value)?.model ?? value;
  } catch {
    return '渠道配置无效';
  }
}
export type AvailableDeliveryChannel = Pick<
  WorkModelChannel,
  'id' | 'version' | 'name' | 'protocol' | 'models' | 'enabled'
> & { configured: boolean };
export type RuntimeDeliveryChannel = {
  workspaceId: string;
  channel: WorkModelChannel;
  model: string;
  encryptedValues: string | null;
};
export interface DeliveryModelChannels {
  resolve(
    fence: DeliveryFence,
    reference: string,
  ): Promise<RuntimeDeliveryChannel>;
}
