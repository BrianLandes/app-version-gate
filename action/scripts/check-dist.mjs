// Fails when dist/index.js differs from a fresh build of the current source.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle, ROOT } from "./build.mjs";

const dir = mkdtempSync(join(tmpdir(), "app-version-gate-dist-"));
try {
  const fresh = join(dir, "index.js");
  await bundle(fresh);
  let committed;
  try {
    committed = readFileSync(join(ROOT, "dist/index.js"));
  } catch {
    console.error("dist/index.js is missing. Run `npm run build` and commit it.");
    process.exit(1);
  }
  if (!committed.equals(readFileSync(fresh))) {
    console.error("dist/index.js is stale. Run `npm run build` and commit the result.");
    process.exit(1);
  }
  console.log("dist/index.js is up to date.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
