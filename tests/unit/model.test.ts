import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompatibleDeliveryModel } from '../../adapters/model/src/index';

const input = () => ({
  model: 'fixture-model',
  system: '系统规则',
  prompt: '用户目标',
  maxTokens: 5000,
  signal: new AbortController().signal,
});
function modelResponse(
  content: string | null,
  finishReason: string | undefined,
  totalTokens?: number | string,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage:
          totalTokens === undefined ? undefined : { total_tokens: totalTokens },
      }),
    ),
  );
  return new CompatibleDeliveryModel({
    baseUrl: 'https://offline-fixture.invalid/v1',
    model: 'fixture-model',
    apiKey: 'fixture-only',
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('兼容模型响应的完整性与计费', () => {
  it('长度截断即使产生完整JSON也标记未完成，保留实际usage供runtime结算', async () => {
    const model = modelResponse(
      '{"approved":true,"issues":[]}',
      'length',
      6123,
    );
    expect(await model.generate(input())).toEqual({
      text: '{"approved":true,"issues":[]}',
      totalTokens: 6123,
      truncated: true,
    });
  });

  it('没有可见文本的截断也保留usage并明确阻止阶段完成', async () => {
    const model = modelResponse(null, 'length', 5000);
    expect(await model.generate(input())).toEqual({
      text: '',
      totalTokens: 5000,
      truncated: true,
    });
  });

  it.each([undefined, 0, '6123'])(
    '截断缺少合法usage（%s）时保留原预占额',
    async (usage) => {
      const model = modelResponse('未完成', 'length', usage);
      const request = input();
      const result = await model.generate(request);
      expect(result.truncated).toBe(true);
      expect(result.totalTokens).toBe(
        Buffer.byteLength(request.system + request.prompt, 'utf8') +
          request.maxTokens,
      );
    },
  );

  it.each(['stop', undefined])(
    '完整响应或兼容服务省略finish_reason（%s）仍沿用正常输出',
    async (reason) => {
      const model = modelResponse('完整设计文档', reason, 128);
      expect(await model.generate(input())).toEqual({
        text: '完整设计文档',
        totalTokens: 128,
      });
    },
  );
});
