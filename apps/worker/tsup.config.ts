import { defineConfig } from 'tsup';
export default defineConfig({
  noExternal: [/^@tandem\//],
  external: ['pino', 'pg', 'zod'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  clean: true,
});
