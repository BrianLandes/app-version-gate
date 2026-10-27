// Bundle src/index.ts and its dependencies into a single ESM file. GitHub runs
// JavaScript actions straight from the repository without installing
// node_modules, so dist/index.js is committed. `npm run check-dist` fails when
// it is stale.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function bundle(outfile) {
  await build({
    absWorkingDir: ROOT,
    entryPoints: ["src/index.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
    logLevel: "warning",
    // Some bundled dependencies are CommonJS and call require() for Node
    // built-ins; give the ESM bundle a real require.
    banner: {
      js: "import { createRequire as __avgCreateRequire } from 'node:module'; const require = __avgCreateRequire(import.meta.url);",
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bundle(process.argv[2] ?? "dist/index.js");
}
