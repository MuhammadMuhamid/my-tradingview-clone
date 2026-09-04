"use client";
/**
 * Saved chart layouts — the server-side ones, not the pane arrangement.
 *
 * Two different things are called a "layout" in this product and they are kept
 * apart on purpose:
 *
 *   a SAVED LAYOUT is a named workspace snapshot in PostgreSQL — symbol,
 *   timeframe, history depth, strategy, its params and properties, and the
 *   moving averages. It describes ONE chart, so opening one applies it to the
 *   focused pane;
 *   the PANE ARRANGEMENT — how many charts and where — is device-local
 *   furniture in `lib/workspace`, because it is about this screen.
 *
 * Saving is the one place a silent failure is unacceptable: a layout is an
 * arrangement a user made deliberately, and "Layout saved" when the request
 * failed means they close the tab believing it is safe (FE-13). Autosave is
 * the exception to interrupting — the user did not ask for that write and is
 * mid-work — so its failure is reported quietly in the layout menu instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as layoutStore from "./layouts";
import type { Layout, WorkspaceState } from "./layouts";

/** JSON.stringify with recursively sorted keys — server JSONB reorders keys. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export interface SavedLayoutsInput {
  /** The focused pane's state, in the shape a saved layout stores. */
  workspaceState: WorkspaceState;
  /** Apply a restored layout to the workspace. Must be stable. */
  applyLayout: (state: WorkspaceState) => void;
  /** Called after a layout is opened — the automatic backtest. Must be stable. */
  onRestored: () => void;
  /**
   * A deep link owns the workspace this load, so the stored layout must not
   * fight it. The layout list is still fetched for the menu: the user may
   * dismiss the link, and the layout they left is then what they get on the
   * NEXT load rather than being silently replaced on this one.
   */
  skipRestore: boolean;
  /** The default name a "save" prompt offers. */
  defaultName: string;
  onToast: (message: string) => void;
  onError: (message: string) => void;
}

export interface SavedLayoutsApi {
  layouts: Layout[];
  currentId: string | null;
  setCurrentId: (id: string | null) => void;
  autosave: boolean;
  /** The focused pane has drifted from the saved layout. */
  dirty: boolean;
  autosaveError: string | null;
  saveNow: () => Promise<void>;
  refresh: () => Promise<void>;
  handlers: {
    onSelect: (id: string) => void;
    onSaveNow: () => void;
    onToggleAutosave: () => void;
    onCreate: () => void;
    onCopy: () => void;
    onRename: () => void;
    onDelete: (id: string) => void;
  };
}

export function useSavedLayouts(input: SavedLayoutsInput): SavedLayoutsApi {
  const { workspaceState, applyLayout, onRestored, skipRestore, defaultName,
    onToast, onError } = input;
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [currentLayoutId, setCurrentLayoutId] = useState<string | null>(null);
  const [autosave, setAutosaveState] = useState(true);
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentLayout = useMemo(
    () => layouts.find((l) => l.id === currentLayoutId) ?? null,
    [layouts, currentLayoutId]
  );

  const dirty = useMemo(() => {
    if (!currentLayout) return false;
    const { id: _i, name: _n, updatedAt: _u, ...saved } = currentLayout;
    return stableStringify(saved) !== stableStringify(workspaceState);
  }, [currentLayout, workspaceState]);

  const refreshLayouts = useCallback(async () => {
    try {
      setLayouts(await layoutStore.listLayouts());
    } catch { /* backend offline — keep the current list */ }
  }, []);

  // Mount: import any pre-database layouts, sync deployment layouts, list them,
  // and restore the one the user left open.
  useEffect(() => {
    setAutosaveState(layoutStore.getAutosave());
    let live = true;
    (async () => {
      await layoutStore.migrateLegacyLayouts();
      await layoutStore.syncDeploymentLayouts();
      let all: Layout[] = [];
      try {
        all = await layoutStore.listLayouts();
      } catch { return; }
      if (!live) return;
      setLayouts(all);
      if (skipRestore) return;
      const curId = layoutStore.getCurrentLayoutId();
      const l = curId ? all.find((x) => x.id === curId) ?? null : null;
      if (l) {
        setCurrentLayoutId(l.id);
        applyLayout(l);
        onRestored();
      }
    })();
    return () => { live = false; };
  }, [skipRestore, applyLayout, onRestored]);

  // Autosave (debounced) when enabled and the workspace drifts from the layout.
  useEffect(() => {
    if (!autosave || !currentLayoutId || !dirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      // Autosave is the one place a failure should not interrupt: the user did
      // not ask for this write and is mid-work. It is still SAID, in the
      // layout menu's own state, rather than discarded.
      void layoutStore.saveLayout(currentLayoutId, workspaceState)
        .then(refreshLayouts)
        .then(() => setAutosaveError(null))
        .catch((e: Error) => setAutosaveError(e.message));
    }, 800);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [autosave, currentLayoutId, dirty, workspaceState, refreshLayouts]);


  // ⌘S / Ctrl+S saves the current layout, like TV.
  const saveNow = useCallback(async () => {
    try {
      if (currentLayoutId) {
        await layoutStore.saveLayout(currentLayoutId, workspaceState);
        await refreshLayouts();
        setAutosaveError(null);
        onToast("Layout saved");
      } else {
        const name = window.prompt("Layout name:", defaultName);
        if (name !== null) {
          const l = await layoutStore.createLayout(name, workspaceState);
          setCurrentLayoutId(l.id);
          await refreshLayouts();
          onToast("Layout saved");
        }
      }
    } catch (e) {
      // Previously this reported "Layout saved" whether or not anything was
      // saved, which is the one thing a save confirmation must never do.
      onError(`Layout not saved: ${(e as Error).message}`);
    }
  }, [currentLayoutId, workspaceState, defaultName, refreshLayouts, onToast, onError]);

  const layoutHandlers = useMemo(() => ({
    onSelect: (id: string) => {
      const l = layouts.find((x) => x.id === id);
      if (!l) return;
      layoutStore.setCurrentLayoutId(id);
      setCurrentLayoutId(id);
      applyLayout(l);
      onRestored();
    },
    onSaveNow: () => { void saveNow(); },
    onToggleAutosave: () => {
      const next = !autosave;
      layoutStore.setAutosave(next);
      setAutosaveState(next);
    },
    onCreate: () => {
      const name = window.prompt("New layout name:", defaultName);
      if (name === null) return;
      void layoutStore.createLayout(name, workspaceState).then(async (l) => {
        setCurrentLayoutId(l.id);
        await refreshLayouts();
      }).catch((e) => onError((e as Error).message));
    },
    onCopy: () => {
      const name = window.prompt("Copy name:", `${currentLayout?.name ?? "Layout"} copy`);
      if (name === null) return;
      void layoutStore.createLayout(name, workspaceState).then(async (l) => {
        setCurrentLayoutId(l.id);
        await refreshLayouts();
      }).catch((e) => onError((e as Error).message));
    },
    onRename: () => {
      if (!currentLayoutId) return;
      const name = window.prompt("Rename layout:", currentLayout?.name ?? "");
      if (name === null) return;
      void layoutStore.renameLayout(currentLayoutId, name)
        .then(refreshLayouts)
        .catch((e: Error) => onError(`Layout not renamed: ${e.message}`));
    },
    onDelete: (id: string) => {
      if (!window.confirm("Delete this layout?")) return;
      void layoutStore.deleteLayout(id).then(async () => {
        if (id === currentLayoutId) setCurrentLayoutId(null);
        await refreshLayouts();
      }).catch(async (e: Error) => {
        onError(`Layout not deleted: ${e.message}`);
        await refreshLayouts();
      });
    },
  }), [layouts, applyLayout, onRestored, saveNow, autosave, defaultName,
    workspaceState, currentLayout, currentLayoutId, refreshLayouts, onError]);
  // ⌘S / Ctrl+S saves the current layout, like TV.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveNow]);

  return {
    layouts, currentId: currentLayoutId, setCurrentId: setCurrentLayoutId,
    autosave, dirty, autosaveError, saveNow, refresh: refreshLayouts, handlers: layoutHandlers,
  };
}
