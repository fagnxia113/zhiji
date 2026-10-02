import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const server = spawn(process.execPath, [vite, "--host", "127.0.0.1"], { cwd: desktop, stdio: "inherit" });
let serverExited = false;
server.on("exit", () => { serverExited = true; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (serverExited) throw Error("UI test server exited before becoming ready");
    try { ready = (await fetch("http://127.0.0.1:1422", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* wait for startup */ }
    if (ready) break;
    await delay(500);
  }
  if (!ready) throw Error("UI test server did not become ready");
  const selected = process.argv.slice(2);
  for (const file of selected.length ? selected : ["tests/workbench.spec.mjs", "tests/work-journal.spec.mjs", "tests/global-search.spec.mjs", "tests/tooltip.spec.mjs", "tests/meeting-sticky.spec.mjs", "tests/project-hub.spec.mjs", "tests/project-usability.spec.mjs", "tests/project-layout.spec.mjs", "tests/project-efficiency.spec.mjs"]) {
  const code = await new Promise((resolve, reject) => {
    const test = spawn(process.execPath, [file], { cwd: root, stdio: "inherit" });
    test.on("error", reject);
    test.on("exit", code => resolve(code ?? 1));
  });
  process.exitCode = code;
  if (code) break;
  }
} finally { server.kill(); }
