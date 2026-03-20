/**
 * ZEGIRON Command — Track Store
 * frontend/src/state/trackStore.ts
 *
 * Zustand store. Hot-path design:
 *   - tracks stored as Map<id, track> — O(1) read/write
 *   - React components subscribe to DERIVED values (counts, selected)
 *   - Canvas reads the Map imperatively via getState() — no React re-render
 *   - applyDelta mutates the existing Map then sets a new Map reference
 *     to trigger Zustand subscriptions without allocating 10k objects
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { RenderedTrack } from '../tactical/TrackRenderer';

// ─── State shape ──────────────────────────────────────────────────────────────
export interface TrackStoreState {
  tracks:     Map<number, RenderedTrack>;
  selectedId: number | null;
  syncing:    boolean;
  total:      number;
  hostile:    number;

  // Actions
  applySnapshot:   (tracks: RenderedTrack[]) => void;
  applyDelta:      (updated: RenderedTrack[], lost: number[]) => void;
  setSyncing:      (v: boolean) => void;
  selectTrack:     (id: number | null) => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────
export const useTrackStore = create<TrackStoreState>()(
  subscribeWithSelector((set, get) => ({
    tracks:     new Map(),
    selectedId: null,
    syncing:    true,
    total:      0,
    hostile:    0,

    applySnapshot(incoming) {
      const map = new Map<number, RenderedTrack>(incoming.map(t => [t.id, t]));
      let hostile = 0;
      for (const t of map.values()) if (t.threat === 'HOSTILE') hostile++;
      set({ tracks: map, total: map.size, hostile, syncing: false });
    },

    applyDelta(updated, lost) {
      // Mutate existing Map (avoid re-allocating 10k entries)
      const map = get().tracks;
      updated.forEach(t => map.set(t.id, t));
      lost.forEach(id => map.delete(id));

      // Recount hostile (fast O(n) pass on the changed subset only)
      let hostile = get().hostile;
      for (const t of updated) {
        const prev = map.get(t.id);
        const prevHostile = prev?.threat === 'HOSTILE';
        const currHostile = t.threat     === 'HOSTILE';
        if (!prevHostile &&  currHostile) hostile++;
        if ( prevHostile && !currHostile) hostile--;
      }
      for (const id of lost) {
        if (map.get(id)?.threat === 'HOSTILE') hostile--;
      }

      // New Map reference → triggers Zustand subscriptions
      set({ tracks: new Map(map), total: map.size, hostile: Math.max(0, hostile) });
    },

    setSyncing: v => set({ syncing: v }),
    selectTrack: id => set({ selectedId: id }),
  })),
);

// ─── Imperative accessor (for canvas — bypasses React entirely) ───────────────
export const getTrackMap = () => useTrackStore.getState().tracks;

// ─── Focused selectors (each component subscribes to only what it needs) ──────
export const useTrackStats = () =>
  useTrackStore(s => ({ total: s.total, hostile: s.hostile, syncing: s.syncing }));

export const useSelectedTrack = () =>
  useTrackStore(s => s.selectedId !== null ? s.tracks.get(s.selectedId) ?? null : null);
