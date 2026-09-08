import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const vite = fileURLToPath(new URL("../apps/desktop/node_modules/vite/bin/vite.js", import.meta.url));
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
  const code = await new Promise((resolve, reject) => {
    const test = spawn(process.execPath, ["tests/workbench.spec.mjs"], { cwd: root, stdio: "inherit" });
    test.on("error", reject);
    test.on("exit", code => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally { server.kill(); }
