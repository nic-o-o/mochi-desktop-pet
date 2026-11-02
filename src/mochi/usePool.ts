/* The team's too-easy pool for the panel. It changes about once a day, so read
 * it when the panel opens, at most every 30 minutes. */
import { useEffect, useRef, useState } from 'react';
import { fetchPool } from './shell.ts';
import type { PoolTask } from './shell.ts';

const REFRESH_MS = 30 * 60 * 1000;

export interface PoolState {
  tasks: PoolTask[];
  updated: string | null;
}

/** Null until a pool has been read (or outside the desktop shell, or before one is published). */
export function usePool(active: boolean): PoolState | null {
  const [pool, setPool] = useState<PoolState | null>(null);
  const lastRead = useRef(0);
  useEffect(() => {
    if (!active || Date.now() - lastRead.current < REFRESH_MS) return;
    lastRead.current = Date.now();
    let live = true;
    void fetchPool().then((r) => {
      if (live && r?.ok) setPool({ tasks: r.tasks, updated: r.updated });
    });
    return () => {
      live = false;
    };
  }, [active]);
  return pool;
}
