/**
 * ZEGIRON Command — Tactical Display Component
 * frontend/src/components/TacticalDisplay.tsx
 *
 * React shell that:
 *  1. Creates the MapLayer (imperative WebGL + pan/zoom)
 *  2. Manages the WebSocketClient lifecycle
 *  3. Feeds decoded frames into both MapLayer (GPU) and trackStore (state)
 *  4. Renders React UI overlays: stats bar, detail panel, alert feed
 */

import React, {
  useRef, useEffect, useCallback, memo,
} from 'react';
import { MapLayer }         from '../tactical/MapLayer';
import { WebSocketClient }  from '../services/websocketClient';
import {
  useTrackStore,
  useTrackStats,
  useSelectedTrack,
} from '../state/trackStore';

// ─── Env ─────────────────────────────────────────────────────────────────────
const WS_URL = import.meta.env.VITE_WS_URL as string ?? 'ws://localhost:4000/ws';

// ─── Root component ───────────────────────────────────────────────────────────
export const TacticalDisplay: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<MapLayer | null>(null);
  const wsRef        = useRef<WebSocketClient | null>(null);

  const { applySnapshot, applyDelta, setSyncing, selectTrack } =
    useTrackStore.getState();

  // ── Bootstrap MapLayer + WebSocketClient once ──────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLayer({
      container,
      onSelect: id => selectTrack(id),
    });
    mapRef.current = map;

    const ws = new WebSocketClient(WS_URL, {
      onConnected: ({ trackCount }) => {
        setSyncing(true);
        console.info(`[WS] Connected — server has ${trackCount} tracks`);
      },
      onSnapshot: tracks => {
        map.loadSnapshot(tracks);
      },
      onSnapshotComplete: total => {
        setSyncing(false);
        // Rebuild store from map's current track set
        const allTracks = Array.from(
          (window as any).__zegiron_tracks ?? new Map()
        );
        console.info(`[WS] Snapshot complete — ${total} tracks`);
      },
      onDelta: (updated, lost) => {
        map.applyDelta(updated, lost);
        applyDelta(updated, lost);
      },
      onDisconnected: () => setSyncing(true),
    });
    wsRef.current = ws;

    return () => {
      ws.destroy();
      map.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#04090f' }}>
      {/* WebGL lives here — managed by MapLayer, not React */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* React overlays */}
      <StatsBar />
      <TrackDetailPanel />
      <SyncIndicator />
    </div>
  );
};

// ─── Stats bar ────────────────────────────────────────────────────────────────
const StatsBar = memo(() => {
  const { total, hostile } = useTrackStats();
  return (
    <div style={{
      position: 'absolute', bottom: 12, left: 12,
      display: 'flex', gap: 8,
      fontFamily: "'Share Tech Mono', 'Courier New', monospace",
    }}>
      {[
        { label: 'TRACKS',  value: total,   color: '#00e5ff' },
        { label: 'HOSTILE', value: hostile, color: '#ff2244' },
      ].map(({ label, value, color }) => (
        <div key={label} style={{
          background: 'rgba(4,9,15,0.85)',
          border: `1px solid ${color}33`,
          borderRadius: 4, padding: '5px 12px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 20, fontWeight: 800, color, lineHeight: 1 }}>
            {value.toLocaleString()}
          </div>
          <div style={{ fontSize: 8, color: '#4a6178', letterSpacing: '0.12em', marginTop: 2 }}>
            {label}
          </div>
        </div>
      ))}
    </div>
  );
});
StatsBar.displayName = 'StatsBar';

// ─── Track detail panel ───────────────────────────────────────────────────────
const TrackDetailPanel = memo(() => {
  const track = useSelectedTrack();
  if (!track) return null;

  const threatColor = {
    HOSTILE: '#ff2244', NEUTRAL: '#f5a623',
    FRIENDLY: '#00e5a0', UNKNOWN: '#7b8fa1',
  }[track.threat] ?? '#7b8fa1';

  const rows: [string, string][] = [
    ['ID',         `0x${track.id.toString(16).toUpperCase().padStart(4,'0')}`],
    ['LAT/LON',    `${track.lat.toFixed(4)}° / ${track.lon.toFixed(4)}°`],
    ['HEADING',    `${track.heading_deg.toFixed(1)}°`],
    ['CONFIDENCE', `${track.confidence}%`],
    ['DOMAIN',     track.domain],
    ['THREAT',     track.threat],
  ];

  return (
    <div style={{
      position: 'absolute', top: 12, right: 12,
      background: 'rgba(4,9,15,0.92)',
      border: `1px solid ${threatColor}44`,
      borderRadius: 6, padding: '10px 14px', minWidth: 220,
      fontFamily: "'Share Tech Mono', monospace", fontSize: 11,
    }}>
      <div style={{ color: threatColor, fontWeight: 700, letterSpacing: '0.1em', marginBottom: 8 }}>
        ▶ TRACK {track.id}
      </div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ color: '#4a6178' }}>{k}</span>
          <span style={{ color: '#c8d8e8' }}>{v}</span>
        </div>
      ))}
    </div>
  );
});
TrackDetailPanel.displayName = 'TrackDetailPanel';

// ─── Sync indicator ───────────────────────────────────────────────────────────
const SyncIndicator = memo(() => {
  const { syncing } = useTrackStats();
  if (!syncing) return null;
  return (
    <div style={{
      position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(245,166,35,0.12)',
      border: '1px solid #f5a62344',
      borderRadius: 4, padding: '4px 14px',
      fontFamily: 'monospace', fontSize: 10,
      color: '#f5a623', letterSpacing: '0.12em',
    }}>
      ⟳ SYNCING…
    </div>
  );
});
SyncIndicator.displayName = 'SyncIndicator';
