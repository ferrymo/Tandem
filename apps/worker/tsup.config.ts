import { defineConfig } from 'tsup';
export default defineConfig({
  noExternal: [/^@tandem\//],
  external: ['pino', 'pg', 'zod'],
  clean: true,
});
