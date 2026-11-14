import { DomainError, parseDeliveryChannelModel } from '@tandem/core';
import type {
  DeliveryModel,
  RuntimeDeliveryChannel,
  WorkProtocol,
} from '@tandem/core';

export type ModelEndpointPolicy = {
  allowedOrigins?: string[];
  allowHttp?: boolean;
};
function endpoint(baseUrl: string, policy: ModelEndpointPolicy) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DomainError('INVALID_INPUT', '模型服务地址无效');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new DomainError(
      'INVALID_INPUT',
      '模型地址仅支持不含凭证的 HTTP(S) 地址',
    );
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback && !policy.allowHttp)
    throw new DomainError(
      'UNAVAILABLE',
      '此模型渠道使用 HTTP，请由部署管理员显式允许测试 HTTP 或改用 HTTPS',
    );
  if (
    policy.allowedOrigins?.length &&
    !policy.allowedOrigins.includes(url.origin)
  )
    throw new DomainError('FORBIDDEN', '模型服务地址不在部署允许的来源范围内');
  return url.href.replace(/\/$/, '');
}

/** A typed non-streaming transport for the three configured model protocols. */
export class ProtocolDeliveryModel implements DeliveryModel {
  readonly configured: boolean;
  readonly defaultModel: string;
  private readonly base: string;
  constructor(
    private readonly config: ModelEndpointPolicy & {
      baseUrl: string;
      protocol: WorkProtocol;
      model: string;
      apiKey: string;
      timeoutMs?: number;
    },
  ) {
    this.base = endpoint(config.baseUrl, config);
    this.defaultModel = config.model;
    this.configured = Boolean(
      config.model && (config.apiKey || config.protocol === 'ollama'),
    );
  }
  async generate(input: Parameters<DeliveryModel['generate']>[0]) {
    if (!this.configured)
      throw new DomainError('UNAVAILABLE', '模型渠道凭证尚未配置');
    const model = input.model || this.defaultModel;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    let path: string;
    let payload: unknown;
    switch (this.config.protocol) {
      case 'openai':
        path = '/chat/completions';
        if (this.config.apiKey)
          headers.Authorization = 'Bearer ' + this.config.apiKey;
        payload = {
          model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.prompt },
          ],
          max_tokens: input.maxTokens,
          temperature: 0.2,
        };
        break;
      case 'anthropic':
        path = '/messages';
        headers['x-api-key'] = this.config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        payload = {
          model,
          system: input.system,
          messages: [{ role: 'user', content: input.prompt }],
          max_tokens: input.maxTokens,
          temperature: 0.2,
        };
        break;
      case 'ollama':
        path = '/api/chat';
        if (this.config.apiKey)
          headers.Authorization = 'Bearer ' + this.config.apiKey;
        payload = {
          model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.prompt },
          ],
          stream: false,
          options: { num_predict: input.maxTokens, temperature: 0.2 },
        };
        break;
    }
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.config.timeoutMs ?? 180000),
    ]);
    let response: Response;
    try {
      response = await fetch(this.base + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
        redirect: 'error',
      });
    } catch {
      throw new DomainError(
        'UNAVAILABLE',
        input.signal.aborted
          ? '模型请求已中断'
          : '模型服务暂时不可达或超时，调用预算已计入',
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
    if (!reader) throw new DomainError('UNAVAILABLE', '模型服务返回空响应');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2000000)
          throw new DomainError('UNAVAILABLE', '模型响应超过大小限制');
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('UNAVAILABLE', '读取模型响应失败，调用预算已计入');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new DomainError(
        'UNAVAILABLE',
        '模型服务未返回有效 JSON，请检查协议',
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new DomainError('UNAVAILABLE', '模型返回内容与所选协议不符');
    const data = parsed as Record<string, unknown>;
    const choices: {
      message?: { content?: unknown };
      finish_reason?: unknown;
    }[] = Array.isArray(data.choices) ? data.choices : [];
    const content: { type?: unknown; text?: unknown }[] = Array.isArray(
      data.content,
    )
      ? data.content
      : [];
    const text =
      this.config.protocol === 'openai'
        ? choices[0]?.message?.content
        : this.config.protocol === 'anthropic'
          ? content
              .filter(
                (entry) =>
                  entry?.type === 'text' && typeof entry.text === 'string',
              )
              .map((entry) => entry.text)
              .join('')
          : (data.message as { content?: unknown } | undefined)?.content;
    const usage =
      data.usage && typeof data.usage === 'object'
        ? (data.usage as Record<string, unknown>)
        : {};
    const truncated =
      this.config.protocol === 'openai'
        ? choices[0]?.finish_reason === 'length'
        : this.config.protocol === 'anthropic'
          ? data.stop_reason === 'max_tokens'
          : data.done_reason === 'length';
    const count = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
    const reported =
      this.config.protocol === 'openai'
        ? count(usage.total_tokens)
        : this.config.protocol === 'anthropic'
          ? count(usage.input_tokens) + count(usage.output_tokens)
          : count(data.prompt_eval_count) + count(data.eval_count);
    const totalTokens =
      reported > 0
        ? reported
        : Buffer.byteLength(
            input.system +
              input.prompt +
              (typeof text === 'string' ? text : ''),
            'utf8',
          ) + (truncated ? input.maxTokens : 0);
    if (truncated)
      return {
        text: typeof text === 'string' ? text : '',
        totalTokens,
        truncated: true,
      };
    if (typeof text !== 'string' || !text.trim())
      throw new DomainError(
        'UNAVAILABLE',
        '模型没有返回有效答复，请检查模型与协议',
      );
    return { text, totalTokens };
  }
}

/** Resolves a pinned workspace channel before every call; plaintext only lives in this invocation. */
export class RoutedDeliveryModel implements DeliveryModel {
  readonly configured: boolean;
  readonly defaultModel: string;
  constructor(
    private readonly config: ModelEndpointPolicy & {
      fallback: DeliveryModel;
      models: string[];
      resolve(reference: string): Promise<RuntimeDeliveryChannel>;
      open(value: string, context: string): string;
    },
  ) {
    this.defaultModel = config.fallback.defaultModel;
    this.configured = config.models.every(
      (model) =>
        Boolean(parseDeliveryChannelModel(model)) || config.fallback.configured,
    );
  }
  async generate(input: Parameters<DeliveryModel['generate']>[0]) {
    if (!parseDeliveryChannelModel(input.model))
      return this.config.fallback.generate(input);
    const resolved = await this.config.resolve(input.model);
    let apiKey = '';
    if (resolved.encryptedValues) {
      try {
        const secret = JSON.parse(
          this.config.open(
            resolved.encryptedValues,
            `work-credential:${resolved.workspaceId}:model-channel:${resolved.channel.id}`,
          ),
        ) as { apiKey?: unknown };
        if (typeof secret.apiKey !== 'string' || !secret.apiKey)
          throw new Error();
        apiKey = secret.apiKey;
      } catch {
        throw new DomainError(
          'UNAVAILABLE',
          '此工作空间的模型凭证无法解密，请重新保存渠道 API key',
        );
      }
    }
    const model = new ProtocolDeliveryModel({
      baseUrl: resolved.channel.baseUrl,
      protocol: resolved.channel.protocol,
      model: resolved.model,
      apiKey,
      ...(this.config.allowedOrigins
        ? { allowedOrigins: this.config.allowedOrigins }
        : {}),
      ...(this.config.allowHttp !== undefined
        ? { allowHttp: this.config.allowHttp }
        : {}),
    });
    return model.generate({ ...input, model: resolved.model });
  }
}
