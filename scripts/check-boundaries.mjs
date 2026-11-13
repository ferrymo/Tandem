import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
const root = process.cwd();
const rules = {
  core: [],
  application: ['core', 'capabilities'],
  'agent-runtime': ['core', 'application', 'capabilities'],
  capabilities: ['core'],
  platform: [],
  'storage-postgres': ['core'],
  zentao: ['core'],
  model: ['core'],
  'mcp-client': ['core'],
  execution: ['core'],
  web: [
    'application',
    'core',
    'platform',
    'storage-postgres',
    'agent-runtime',
    'capabilities',
    'zentao',
    'model',
    'mcp-client',
    'execution',
  ],
  worker: [
    'application',
    'core',
    'platform',
    'storage-postgres',
    'agent-runtime',
    'capabilities',
    'zentao',
    'model',
    'mcp-client',
    'execution',
  ],
  mcp: ['platform'],
};
let failures = 0;
function violation(file, message) {
  console.error(relative(root, file) + ': ' + message);
  failures++;
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}
for (const category of ['apps', 'packages', 'adapters'])
  for (const name of readdirSync(category)) {
    const base = join(root, category, name);
    const manifest = JSON.parse(
      readFileSync(join(base, 'package.json'), 'utf8'),
    );
    const allowed = rules[name];
    if (!allowed) throw new Error('缺少模块规则：' + name);
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (dep.startsWith('@tandem/') && !allowed.includes(dep.slice(8)))
        violation(join(base, 'package.json'), '禁止依赖 ' + dep);
      if (
        ['core', 'application', 'agent-runtime', 'capabilities'].includes(
          name,
        ) &&
        !dep.startsWith('@tandem/')
      )
        violation(
          join(base, 'package.json'),
          '领域层不可依赖外部运行库 ' + dep,
        );
    }
    for (const file of walk(join(base, 'src')).filter((p) =>
      /\.[cm]?tsx?$/.test(p),
    )) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node) => {
        let spec;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          spec = node.moduleSpecifier.text;
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        )
          spec = node.arguments[0].text;
        if (spec) {
          if (
            spec.startsWith('@tandem/') &&
            !allowed.includes(spec.slice(8).split('/')[0])
          )
            violation(file, '禁止导入 ' + spec);
          if (
            spec.startsWith('.') &&
            !resolve(file, '..', spec).startsWith(
              base +
                '/'.replace('/', process.platform === 'win32' ? '\\' : '/'),
            )
          )
            violation(file, '跨模块相对导入 ' + spec);
          if (
            ['core', 'application', 'agent-runtime', 'capabilities'].includes(
              name,
            ) &&
            !spec.startsWith('.') &&
            !spec.startsWith('@tandem/')
          )
            violation(file, '领域层外部导入 ' + spec);
          if (
            category === 'apps' &&
            name === 'web' &&
            /[/\\](app|components)[/\\]/.test(file) &&
            /^@tandem\/(storage-postgres|zentao|model|execution|mcp-client)$/.test(
              spec,
            )
          )
            violation(file, '页面/API 必须通过 server 组装依赖：' + spec);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
if (failures) process.exit(1);
console.log('模块依赖边界检查通过');
