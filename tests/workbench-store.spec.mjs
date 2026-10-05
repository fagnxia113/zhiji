import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(new URL("../apps/desktop/src/zhiji/workbench/store.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
const { createWorkbenchStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const data = name => ({ projects: [{ id: name, name }], entries: [], links: {} });
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const loads = [];
  let listeners = 0, stops = 0, emit;
  const store = createWorkbenchStore({
    load: () => new Promise((resolve, reject) => loads.push({ resolve, reject })),
    listen: async changed => { listeners++; emit = changed; return () => stops++; },
  });
  return { store, loads, emit: () => emit(), counts: () => ({ listeners, stops }) };
}

{
  const h = harness(), snapshots = [];
  const stopFirst = h.store.subscribe(() => snapshots.push(h.store.getSnapshot()));
  h.store.subscribe(() => {});
  assert.equal(h.loads.length, 1, "multiple mounted views share one initial read");
  assert.equal(h.counts().listeners, 1);
  const first = h.store.refresh(), second = h.store.refresh();
  h.loads[0].resolve(data("before-write"));
  await tick();
  assert.equal(snapshots.length, 0, "a stale pre-write read must not publish");
  assert.equal(h.loads.length, 2, "pending requests coalesce into one latest read");
  h.loads[1].resolve(data("after-write"));
  assert.equal(await first, true); assert.equal(await second, true);
  assert.equal(h.store.getSnapshot().data.projects[0].id, "after-write");
  stopFirst(); h.store.subscribe(() => {});
  assert.equal(h.loads.length, 2, "switching views uses the shared snapshot");
  h.emit(); await tick(); assert.equal(h.loads.length, 3);
  h.loads[2].reject(Error("offline")); await tick();
  assert.equal(h.store.getSnapshot().data.projects[0].id, "after-write");
  assert.match(h.store.getSnapshot().error, /offline/);
  const retry = h.store.refresh(); h.loads[3].resolve(data("recovered"));
  assert.equal(await retry, true); assert.equal(h.store.getSnapshot().error, "");
  h.store.dispose(); assert.equal(h.counts().stops, 1);
}
{
  const h = harness(); let followup, settled = false;
  h.store.subscribe(() => {
    if (!followup) followup = h.store.refresh().then(() => { settled = true; });
  });
  h.loads[0].resolve(data("initial")); await tick();
  assert.equal(settled, false, "a refresh requested by a subscriber waits for its own read");
  h.loads[1].resolve(data("followup")); await followup;
  assert.equal(h.store.getSnapshot().data.projects[0].id, "followup");
  h.store.dispose();
}
{
  const h = harness(); h.store.subscribe(() => {});
  const pending = h.store.refresh(); h.store.dispose();
  assert.equal(await pending, false);
  h.loads[0].resolve(data("late")); await tick();
  assert.equal(h.store.getSnapshot().data.projects.length, 0, "disposed stores ignore late results");
  assert.equal(await h.store.refresh(), false);
}
console.log("PASS: one shared read/subscription, serialized refresh, stale-result suppression, reentrant waiters, failure recovery and disposal.");
