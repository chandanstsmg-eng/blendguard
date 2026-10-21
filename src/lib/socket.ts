/**
 * One Socket.IO connection per screen. The server pushes run state, live scale
 * readings and "something changed" hints; the screen never trusts the socket
 * for decisions — it only displays.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import type { QueryClient } from '@tanstack/react-query';
import type { RunState, ScaleState } from '@shared/types';

let socket: Socket | null = null;
const listeners = new Set<() => void>();
let connected = false;
/** Increments on every reconnect after a drop; screens use it to ask for an equipment check. */
let reconnects = 0;

export const useScaleStore = create<{ scale: ScaleState | null; set: (s: ScaleState | null) => void }>((set) => ({
  scale: null,
  set: (scale) => set({ scale }),
}));

/** Live weight of every station, for the supervisors' floor monitor. */
export const useFloorScaleStore = create<{ byStation: Record<string, ScaleState>; set: (s: ScaleState) => void }>((set) => ({
  byStation: {},
  set: (s) => set((prev) => ({ byStation: { ...prev.byStation, [s.stationId]: s } })),
}));

function notify() {
  for (const l of listeners) l();
}

export function connectSocket(qc: QueryClient) {
  if (socket) return socket;
  socket = io({ path: '/socket.io', transports: ['websocket', 'polling'], withCredentials: true });
  let wasConnected = false;
  socket.on('connect', () => {
    if (wasConnected) reconnects++;
    wasConnected = true;
    connected = true;
    notify();
    void qc.invalidateQueries();
  });
  socket.on('disconnect', () => {
    connected = false;
    notify();
  });
  socket.on('run', (run: RunState) => qc.setQueryData(['run', run.id], run));
  socket.on('scale', (s: ScaleState) => useScaleStore.getState().set(s));
  socket.on('floor-scale', (s: ScaleState) => useFloorScaleStore.getState().set(s));
  socket.on('jobs-changed', () => void qc.invalidateQueries({ queryKey: ['jobs'] }));
  socket.on('calls-changed', () => {
    void qc.invalidateQueries({ queryKey: ['call'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  });
  socket.on('station-changed', () => {
    void qc.invalidateQueries({ queryKey: ['me'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
    void qc.invalidateQueries({ queryKey: ['batch'] });
  });
  return socket;
}

/** Reconnect so the server re-reads the cookies (after sign-in / sign-out / station setup). */
export function resetSocket() {
  if (!socket) return;
  socket.disconnect();
  socket.connect();
}

export function useSocketStatus() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => connected,
  );
}

export function useReconnectCount() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => reconnects,
  );
}

export function useSocket(qc: QueryClient) {
  useEffect(() => {
    connectSocket(qc);
  }, [qc]);
}
