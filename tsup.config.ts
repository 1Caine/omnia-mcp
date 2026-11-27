import { createRequire } from "node:module";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);

/**
 * One self-contained file, so `npx omnia-mcp` installs a single package.
 * The SDK and the MCP library are bundled in. The CLI uses the same settings.
 */
export const bundle = {
  format: ["esm"] as ["esm"],
  platform: "node" as const,
  target: "node20",
  clean: true,
  dts: false,
  splitting: false,
  noExternal: [/.*/],
  // Optional native speedups of the websocket library. It falls back to plain JavaScript without them.
  external: ["bufferutil", "utf-8-validate"],
  // Bundled CommonJS code calls require() for Node's own modules.
  banner: { js: 'import { createRequire as __omniaRequire } from "node:module";\nconst require = __omniaRequire(import.meta.url);' },
  esbuildOptions(options: { alias?: Record<string, string> }) {
    options.alias = {
      ...options.alias,
      // The package of the same name, in place of Node's deprecated built-in module, which prints a warning on every start.
      punycode: require.resolve("punycode/punycode.js"),
    };
  },
};

export default defineConfig({ ...bundle, entry: { index: "src/index.ts" } });
