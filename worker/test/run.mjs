/* Runs every suite. `node test/run.mjs` from the worker directory. */
import { spawnSync } from "node:child_process";
let failed = 0;
for (const f of ["engine.test.mjs", "audit.test.mjs", "sessions.test.mjs", "rendered-pages.test.mjs"]) {
  console.log(`\n${"=".repeat(52)}\n  ${f}\n${"=".repeat(52)}`);
  const r = spawnSync(process.execPath, [new URL(f, import.meta.url).pathname], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
