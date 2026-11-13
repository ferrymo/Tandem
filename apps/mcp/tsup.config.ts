import { defineConfig } from 'tsup';
export default defineConfig({
  noExternal: [/^@tandem\//],
  external: ['pino', 'zod'],
  clean: true,
});
