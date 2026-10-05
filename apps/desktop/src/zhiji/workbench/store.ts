import type { WorkbenchData } from "../workbench";

type Snapshot = { data: WorkbenchData; error: string; loading: boolean };
type Dependencies = {
  load: () => Promise<WorkbenchData>;
  listen: (changed: () => void) => Promise<() => void>;
};

// A window shares one snapshot. Requests started before a write must not replace
// a newer refresh, and every refresh waits until the latest requested read ends.
export function createWorkbenchStore(dependencies: Dependencies) {
  let snapshot: Snapshot = { data: { projects: [], entries: [], links: {} }, error: "", loading: true };
  const subscribers = new Set<() => void>();
  let requested = 0;
  let completed = 0;
  let running = false;
  let started = false;
  let disposed = false;
  let stopListening: (() => void) | undefined;
  const waiters: ((success: boolean) => void)[] = [];

  const publish = (next: Snapshot) => {
    snapshot = next;
    subscribers.forEach(changed => changed());
  };
  const drain = async () => {
    running = true;
    while (!disposed && completed < requested) {
      const generation = requested;
      let data = snapshot.data;
      let error = "";
      try { data = await dependencies.load(); }
      catch (cause) { error = String(cause); }
      completed = generation;
      if (!disposed && generation === requested) {
        const settled = waiters.splice(0);
        publish({ data, error, loading: false });
        settled.forEach(resolve => resolve(!error));
      }
    }
    running = false;
  };
  const refresh = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    requested++;
    const result = new Promise<boolean>(resolve => waiters.push(resolve));
    if (!running) void drain();
    return result;
  };
  const subscribe = (changed: () => void) => {
    subscribers.add(changed);
    if (!started) {
      started = true;
      void refresh();
      void dependencies.listen(() => { void refresh(); }).then(stop => {
        if (disposed) stop(); else stopListening = stop;
      }).catch(() => undefined);
    }
    return () => { subscribers.delete(changed); };
  };
  const dispose = () => {
    disposed = true;
    stopListening?.();
    subscribers.clear();
    waiters.splice(0).forEach(resolve => resolve(false));
  };
  return { subscribe, getSnapshot: () => snapshot, refresh, dispose };
}
