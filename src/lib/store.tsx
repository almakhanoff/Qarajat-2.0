import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppData, Change } from '../domain/types';
import { applyChanges } from '../domain/commands';
import { loadData, persistChanges, requestPersistentStorage } from './db';

interface StoreValue {
  data: AppData;
  isNew: boolean;
  /** Сохраняет изменения в IndexedDB и только после успеха обновляет состояние. */
  commit: (changes: Change[]) => Promise<void>;
  reload: () => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children, fallback, onError }: { children: ReactNode; fallback: ReactNode; onError: (e: unknown) => ReactNode }) {
  const [state, setState] = useState<{ data: AppData; isNew: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const dataRef = useRef<AppData | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const reload = useCallback(async () => {
    try {
      const res = await loadData();
      dataRef.current = res.data;
      setState(res);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void reload();
    void requestPersistentStorage();
  }, [reload]);

  const commit = useCallback((changes: Change[]) => {
    const run = queue.current.then(async () => {
      await persistChanges(changes);
      const next = applyChanges(dataRef.current!, changes);
      dataRef.current = next;
      setState((s) => (s ? { ...s, data: next } : s));
    });
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const value = useMemo(() => (state ? { data: state.data, isNew: state.isNew, commit, reload } : null), [state, commit, reload]);
  if (error) return <>{onError(error)}</>;
  if (!value) return <>{fallback}</>;
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('StoreProvider missing');
  return v;
}
