import { describe, expect, it } from 'vitest';
import {
  deliveryPreviewIssues,
  validateDeliveryPackage,
} from '../../adapters/execution/src/index';
import type { DeliveryPackage } from '../../packages/core/src/index';

const document = (body: string) =>
  `<!doctype html><html lang="zh"><head><title>离线演示</title></head><body>${body}</body></html>`;

describe('构建生成预览入口', () => {
  const source: DeliveryPackage = {
    files: [
      { path: 'build.mjs', content: '/* build generates the HTML entry */' },
      { path: 'app.test.mjs', content: 'import test from "node:test";' },
    ],
    testCommands: [['node', '--test', 'app.test.mjs']],
    buildCommands: [['node', 'build.mjs']],
    previewPath: 'dist/index.html',
    summary: '构建生成入口',
    limitations: ['静态演示'],
  };
  it('有构建命令时允许入口不在源文件中', () => {
    expect(validateDeliveryPackage(source)).toBe(source);
  });
  it('没有构建命令时仍要求源文件包含入口', () => {
    expect(() =>
      validateDeliveryPackage({ ...source, buildCommands: [] }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() =>
      validateDeliveryPackage({
        ...source,
        buildCommands: [],
        files: [
          ...source.files,
          { path: source.previewPath, content: document('<p>Demo</p>') },
        ],
      }),
    ).not.toThrow();
  });
  it.each([
    '../index.html',
    '/index.html',
    'dist\\index.html',
    'dist/index.js',
    '.tandem-preview.html',
    '.tandem-skills/preview.html',
  ])('有构建命令也拒绝非法或保留入口路径：%s', (previewPath) => {
    expect(() =>
      validateDeliveryPackage({ ...source, previewPath }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('最终产物的隔离预览兼容性', () => {
  it('支持内联经典业务脚本、样式、data图像和页内SVG', () => {
    expect(
      deliveryPreviewIssues(
        document(`
        <style>body { font-family: system-ui; } .icon { background: url("data:image/svg+xml,%3Csvg/%3E"); filter:url(#soft); }</style>
        <svg><defs><filter id="soft"></filter><symbol id="check"></symbol></defs><use href="#check"></use></svg>
        <img src="data:image/png;base64,aGVsbG8=" alt="图标">
        <a href="#result">结果</a>
        <form id="calculator"><input id="amount" type="number"><button>计算</button></form>
        <output id="result"></output>
        <script>
          const state = { total: 0 };
          function total(value) { if (!Number.isFinite(value) || value < 0) throw new Error('输入错误'); return value * 2; }
          document.querySelector('#calculator').addEventListener('submit', event => {
            event.preventDefault();
            state.total = total(Number(document.querySelector('#amount').value));
            document.querySelector('#result').textContent = String(state.total);
          });
        </script>`),
      ),
    ).toEqual([]);
  });

  it('普通文案、注释、字符串、正则和非执行数据块中的API名称不会误报', () => {
    expect(
      deliveryPreviewIssues(
        document(`
        <p>不支持 fetch、localStorage 和 import；这里仅为说明。</p>
        <!-- <script src="./legacy.js"></script><img src="./legacy.png"> -->
        <textarea><script type="module" src="./example.mjs"></script></textarea>
        <script type="application/json">{"fetch":"/api/example","localStorage":true,"source":"<img src='remote.png'>"}</script>
        <script>
          // fetch('/example'); localStorage.setItem('x', 'y');
          /* new WebSocket('wss://example.com'); */
          const help = "fetch('/example') and localStorage are unavailable";
          const labels = ['localStorage'];
          const description = \`import and indexedDB are text\`;
          const pattern = /fetch|localStorage|import/;
          const data = { fetch: 'example', indexedDB: 'example' };
          document.body.title = help + labels[0] + description + pattern.source + data.fetch;
        </script>`),
      ),
    ).toEqual([]);
  });

  it('模板字符串表达式中的实际联网调用仍被检查', () => {
    const html = document(
      '<script>const text = `结果：${fetch("/api")}`;</script>',
    );
    expect(deliveryPreviewIssues(html).join('\n')).toContain('fetch');
  });

  it('惰性的template内容不会冒充已加载资源', () => {
    expect(
      deliveryPreviewIssues(
        document(
          '<template><img src="./example.png"><script src="./example.js"></script></template>',
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    ['外链经典脚本', '<script src="./app.js"></script>', '外链script'],
    [
      'data脚本也不属于内联经典脚本',
      '<script src="data:text/javascript,alert(1)"></script>',
      '外链script',
    ],
    [
      '模块脚本',
      '<script type="module">document.body.dataset.ready = "yes";</script>',
      '模块',
    ],
    [
      '静态模块导入',
      '<script>import { total } from "./domain.mjs";</script>',
      'import/export',
    ],
    [
      '动态模块导入',
      '<script>import("./domain.mjs");</script>',
      'import/export',
    ],
    [
      '导出模块',
      '<script>export function total() { return 1; }</script>',
      'import/export',
    ],
    ['外链样式', '<link rel="stylesheet" href="./styles.css">', 'stylesheet'],
    [
      'CSS资源',
      '<style>.hero { background-image: url("./hero.svg"); }</style>',
      'CSS引用',
    ],
    ['CSS导入', '<style>@import "./theme.css";</style>', '@import'],
    [
      '字体资源',
      '<style>@font-face { font-family: demo; src: url(data:font/woff2;base64,AA); }</style>',
      '系统字体',
    ],
    [
      '内联CSS资源',
      '<div style="background:url(https://example.com/image.png)"></div>',
      'CSS引用',
    ],
    ['相对图像', '<img src="./image.svg" alt="图标">', '非data资源'],
    ['图像片段仍会发起请求', '<img src="#icon" alt="图标">', '非data资源'],
    [
      'SVG外链脚本',
      '<svg><script href="./app.js"></script></svg>',
      '外链script',
    ],
    ['响应式图像', '<img srcset="./small.png 1x, ./large.png 2x">', 'srcset'],
    ['外部SVG', '<svg><use href="./icons.svg#check"></use></svg>', 'SVG引用'],
    ['嵌套文档', '<iframe srcdoc="<p>child</p>"></iframe>', 'iframe'],
    [
      '媒体不在当前CSP支持范围',
      '<video src="data:video/mp4;base64,AA"></video>',
      '媒体资源',
    ],
    [
      '表单外部提交',
      '<form action="/submit"><button>提交</button></form>',
      '表单提交目标',
    ],
    [
      '提交按钮目标',
      '<button formaction="/submit">提交</button>',
      '表单提交目标',
    ],
    ['页面外导航', '<a href="./other.html">下一页</a>', '页面外导航'],
    [
      '下载需要未开放的sandbox权限',
      '<a href="#" download="demo.csv">导出</a>',
      '不支持下载',
    ],
    [
      '自动导航',
      '<meta http-equiv="refresh" content="0; url=/next">',
      '刷新导航',
    ],
    [
      '事件处理器联网',
      '<button onclick="fetch(\'/api\')">刷新</button>',
      'fetch',
    ],
    [
      '实体编码事件',
      '<button onclick="&#102;etch(\'/api\')">刷新</button>',
      'fetch',
    ],
    ['未闭合入口脚本', '<script>const unfinished = true;', '未闭合'],
    ['未闭合入口样式', '<style>body { color: blue; }', '未闭合'],
  ])('拒绝%s并提供可修复原因', (_name, body, reason) => {
    expect(deliveryPreviewIssues(document(body)).join('\n')).toContain(reason);
  });

  it.each([
    'fetch("/api")',
    'window["fetch"]("/api")',
    'new XMLHttpRequest()',
    'new WebSocket("wss://example.com")',
    'new EventSource("/events")',
    'navigator.sendBeacon("/events", "data")',
    'localStorage.getItem("state")',
    'window["localStorage"].getItem("state")',
    'sessionStorage.setItem("state", "value")',
    'indexedDB.open("demo")',
    'navigator.storage.getDirectory()',
    'document.cookie',
    'new Worker("./worker.js")',
    'navigator.serviceWorker.register("./worker.js")',
  ])('拒绝不受支持的活跃API：%s', (source) => {
    expect(
      deliveryPreviewIssues(document(`<script>${source};</script>`)),
    ).not.toEqual([]);
  });

  it('样式说明字符串中的url和import不会当成资源请求', () => {
    expect(
      deliveryPreviewIssues(
        document(
          '<style>.help::before { content: "url(remote.png) @import x"; }</style>',
        ),
      ),
    ).toEqual([]);
  });
});
