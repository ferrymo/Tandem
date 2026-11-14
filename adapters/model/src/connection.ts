import { DomainError } from '@tandem/core';
import type { WorkModelChannel, WorkModelConnection } from '@tandem/core';
import { ProtocolDeliveryModel } from './protocol';
import type { ModelEndpointPolicy } from './protocol';

/** Uses the same transport as Worker; it returns evidence without raw response text. */
export class ProtocolModelConnection implements WorkModelConnection {
  constructor(private readonly policy: ModelEndpointPolicy = {}) {}
  async test(channel: WorkModelChannel, credential: string, model: string) {
    const started = Date.now();
    const adapter = new ProtocolDeliveryModel({
      ...this.policy,
      baseUrl: channel.baseUrl,
      protocol: channel.protocol,
      model,
      apiKey: credential,
      timeoutMs: 30000,
    });
    const result = await adapter.generate({
      model,
      system: 'Connection verification. Reply briefly.',
      prompt: 'Reply with OK.',
      maxTokens: 128,
      signal: new AbortController().signal,
    });
    if (!result.text.trim() || result.truncated)
      throw new DomainError(
        'UNAVAILABLE',
        '模型验证未返回完整答复，请检查模型能力',
      );
    return {
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      model,
      protocol: channel.protocol,
    };
  }
}
