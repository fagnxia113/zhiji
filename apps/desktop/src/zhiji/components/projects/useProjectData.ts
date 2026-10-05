import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { workbenchCall } from "../../workbench";
import { emptyHub, type Hub } from "./model";

export function useProjectData(projectId: string, onChanged: () => Promise<boolean>) {
  const [hub, setHub] = useState<Hub>(emptyHub);
  const [catalog, setCatalog] = useState<Hub>(emptyHub);
  const [ready, setReady] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const alive = useRef(true);
  const reads = useRef(0);
  const operationPending = useRef(false);
  const catalogPending = useRef<Promise<boolean> | null>(null);
  const externalChange = useRef(false);

  const reload = useCallback(async () => {
    const generation = ++reads.current;
    try {
      const next = await workbenchCall<Hub>("load_project_hub", { projectId });
      if (alive.current && generation === reads.current) { setHub(next); setReady(true); }
    } catch (cause) {
      if (alive.current && generation === reads.current) setReady(false);
      throw cause;
    }
  }, [projectId]);
  const loadCatalog = () => {
    if (catalogPending.current) return catalogPending.current;
    setCatalogLoading(true); setCatalogError("");
    const pending = workbenchCall<Hub>("load_project_hub").then(next => {
      if (alive.current) { setCatalog(next); setCatalogReady(true); }
      return true;
    }).catch(cause => {
      if (alive.current) { setCatalogReady(false); setCatalogError(`可复用资料暂时无法读取。${String(cause)}`); }
      return false;
    }).finally(() => { catalogPending.current = null; if (alive.current) setCatalogLoading(false); });
    catalogPending.current = pending;
    return pending;
  };
  const refreshBoth = async () => {
    const results = await Promise.allSettled([reload(), onChanged()]);
    const failed = results.find(result => result.status === "rejected" || result.value === false);
    if (failed) {
      if (alive.current) { setReady(false); setRefreshFailed(true); }
      throw Error(failed.status === "rejected" ? String(failed.reason) : "工作记录列表暂时无法读取");
    }
    if (alive.current) setRefreshFailed(false);
    if (catalogReady) await loadCatalog();
  };
  const retry = async () => {
    if (operationPending.current) return;
    operationPending.current = true;
    setLoading(true);
    try { await refreshBoth(); if (alive.current) setError(""); }
    catch (cause) { if (alive.current) setError(`重新读取失败。${String(cause)}`); }
    finally {
      operationPending.current = false;
      if (alive.current) {
        setLoading(false);
        if (externalChange.current) {
          externalChange.current = false;
          void reload().catch(cause => { if (alive.current) setError(`外部更新暂时无法读取。${String(cause)}`); });
        }
      }
    }
  };
  const perform = async (operation: () => Promise<void | boolean>, changesData = true) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(""); setNotice("");
    let completed = false;
    try {
      if (await operation() === false) return;
      completed = true;
      if (changesData) await refreshBoth();
    } catch (cause) {
      if (alive.current) setError(completed ? `操作已完成，但列表刷新失败；请重新读取，无需重复提交。${String(cause)}` : String(cause));
    } finally {
      operationPending.current = false;
      if (alive.current) {
        setBusy(false);
        if (externalChange.current) {
          externalChange.current = false;
          void reload().catch(cause => { if (alive.current) setError(`外部更新暂时无法读取。${String(cause)}`); });
        }
      }
    }
  };
  useEffect(() => {
    let canceled = false;
    alive.current = true;
    void reload().catch(cause => { if (!canceled) setError(String(cause)); })
      .finally(() => { if (!canceled) setLoading(false); });
    const subscription = listen("zhiji://workbench-changed", () => {
      if (canceled) return;
      if (operationPending.current) { externalChange.current = true; return; }
      void reload().catch(cause => { if (alive.current) setError(`外部更新暂时无法读取。${String(cause)}`); });
    });
    return () => {
      canceled = true;
      alive.current = false;
      reads.current++;
      void subscription.then(stop => stop()).catch(() => undefined);
    };
  }, [reload]);
  return { hub, catalog, ready: ready && !refreshFailed, loading, busy, error, notice, catalogReady, catalogLoading, catalogError, setError, setNotice, reload, loadCatalog, perform, retry };
}
