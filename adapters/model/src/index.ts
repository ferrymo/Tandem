import { DomainError } from '@tandem/core';
import type { DeliveryModel } from '@tandem/core';
export type { ModelProvider } from '@tandem/core';
export { ProtocolModelConnection } from './connection';
export { ProtocolDeliveryModel, RoutedDeliveryModel } from './protocol';

/** Compatible chat-completion transport. Credentials never enter prompts or logs. */
export class CompatibleDeliveryModel implements DeliveryModel {
  readonly configured: boolean;
  readonly defaultModel: string;
  private readonly endpoint: string | null;
  constructor(
    private readonly config: {
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      allowHttp?: boolean;
      timeoutMs?: number;
    },
  ) {
    this.defaultModel = config.model?.trim() ?? '';
    this.configured = Boolean(
      config.baseUrl && this.defaultModel && config.apiKey,
    );
    this.endpoint = null;
    if (config.baseUrl) {
      const address = new URL(config.baseUrl);
      if (
        address.username ||
        address.password ||
        address.search ||
        address.hash ||
        !['http:', 'https:'].includes(address.protocol) ||
        (address.protocol === 'http:' && !config.allowHttp)
      )
        throw new DomainError(
          'INVALID_INPUT',
          '模型服务地址需要 HTTPS，或显式允许测试 HTTP',
        );
      this.endpoint = address.href.replace(/\/$/, '') + '/chat/completions';
    }
  }
  async generate(input: Parameters<DeliveryModel['generate']>[0]) {
    if (!this.configured || !this.endpoint)
      throw new DomainError('UNAVAILABLE', '模型服务未配置');
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.config.timeoutMs ?? 180000),
    ]);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + this.config.apiKey,
        },
        body: JSON.stringify({
          model: input.model || this.defaultModel,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.prompt },
          ],
          max_tokens: input.maxTokens,
          temperature: 0.2,
        }),
        signal,
      });
    } catch {
      throw new DomainError(
        'UNAVAILABLE',
        input.signal.aborted
          ? '模型请求已中断'
          : '模型服务暂时不可达，调用预算已计入',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError(
        'UNAVAILABLE',
        `模型服务返回 HTTP ${response.status}，调用预算已计入`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DomainError('UNAVAILABLE', '模型返回空响应');
    let content = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 2000000)
          throw new DomainError('UNAVAILABLE', '模型响应超过上限');
        content += decoder.decode(item.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    let data: {
      choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
      usage?: { total_tokens?: unknown };
    };
    try {
      data = JSON.parse(content);
    } catch {
      throw new DomainError('UNAVAILABLE', '模型返回无效 JSON');
    }
    const answer = data.choices?.[0]?.message?.content;
    const truncated = data.choices?.[0]?.finish_reason === 'length';
    const usage = data.usage?.total_tokens;
    const totalTokens =
      typeof usage === 'number' && Number.isInteger(usage) && usage > 0
        ? usage
        : truncated
          ? Buffer.byteLength(input.system + input.prompt, 'utf8') +
            input.maxTokens
          : Buffer.byteLength(input.system + input.prompt + answer, 'utf8');
    // Even an empty length-limited response may have consumed reasoning tokens.
    // Settle reported usage before the runtime rejects its incomplete content;
    // without valid usage retain the same conservative reservation as runtime.
    if (truncated)
      return {
        text: typeof answer === 'string' ? answer : '',
        totalTokens,
        truncated: true,
      };
    if (typeof answer !== 'string' || !answer.trim())
      throw new DomainError('UNAVAILABLE', '模型未返回可用内容');
    return { text: answer, totalTokens };
  }
}
