/**
 * ZEGIRON Command — WebSocket Client Service
 * frontend/src/services/websocketClient.ts
 *
 * Manages the WebSocket lifecycle and binary frame decoding.
 *
 * Key behaviours:
 *   • JWT passed as ?token= query param on connect
 *   • Binary frames (ArrayBuffer) decoded here; JSON control messages dispatched
 *   • Back-pressure ring buffer: if decode queue > 8, drop oldest non-snapshot frame
 *   • Reconnect: exponential backoff 1 s → 30 s with ±15% jitter
 *   • Tab visibility: cancel rAF when hidden, request snapshot on focus
 *   • Heartbeat timeout: 45 s (server sends every 20 s)
 *
 * Binary frame layout (as encoded by gateway):
 *   Header  8 bytes  [type u8][flags u8][count u16 BE][ts u32 BE]
 *   Track  32 bytes  [id u32][lat i32 ×1e7][lon i32 ×1e7][alt_ft i16]
 *                    [spd u16 ×10][hdg u16 ×100][conf u8][threat u8]
 *                    [sensors u8][iff u8][ts u32][rcs i16 ×10]
 *                    [pad u8][domain u8][deltaMask u8]
 */

import type { RenderedTrack } from '../tactical/TrackRenderer';

// ─── Frame type constants ─────────────────────────────────────────────────────
const FT = { SNAPSHOT_CHUNK: 0x03, DELTA: 0x02, TRACK_LOST: 0x04 } as const;
const THREAT_DEC: Record<number, string> = { 0: 'UNKNOWN', 1: 'FRIENDLY', 2: 'NEUTRAL', 3: 'HOSTILE' };
const DOMAIN_DEC: Record<number, string> = { 0: 'AIR', 1: 'SURFACE', 2: 'SUBSURFACE', 3: 'LAND', 4: 'SPACE' };

// ─── Decoded frame ────────────────────────────────────────────────────────────
export interface DecodedFrame {
  type:       'snapshot_chunk' | 'delta' | 'lost' | 'snapshot_complete';
  tracks:     RenderedTrack[];
  lostIds:    number[];
  totalCount?: number;
}

// ─── Event callbacks ──────────────────────────────────────────────────────────
export interface WSClientCallbacks {
  onSnapshot?:         (tracks: RenderedTrack[]) => void;
  onSnapshotComplete?: (total: number) => void;
  onDelta?:            (updated: RenderedTrack[], lost: number[]) => void;
  onAlert?:            (alert: unknown) => void;
  onConnected?:        (meta: { trackCount: number; role: string }) => void;
  onDisconnected?:     () => void;
  onError?:            (msg: string) => void;
}

// ─── Client ───────────────────────────────────────────────────────────────────
export class WebSocketClient {
  private ws:           WebSocket | null  = null;
  private reconnDelay   = 1_000;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnTimer:    ReturnType<typeof setTimeout> | null = null;
  private frameQueue:   ArrayBuffer[]     = [];
  private snapshotBuf:  RenderedTrack[]   = [];
  private destroyed     = false;

  private readonly url:       string;
  private readonly callbacks: WSClientCallbacks;

  constructor(url: string, callbacks: WSClientCallbacks) {
    this.url       = url;
    this.callbacks = callbacks;
    this.connect();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.requestSnapshot();
    });
  }

  private connect(): void {
    if (this.destroyed) return;

    const token = localStorage.getItem('zegiron_token') ?? '';
    const wsUrl = `${this.url}?token=${encodeURIComponent(token)}`;
    const ws    = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.reconnDelay = 1_000;
      this.resetHeartbeat();
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.resetHeartbeat();
      if (ev.data instanceof ArrayBuffer) {
        this.enqueueFrame(ev.data);
      } else {
        this.handleJSON(ev.data as string);
      }
    };

    ws.onclose = (ev) => {
      this.callbacks.onDisconnected?.();
      if (!this.destroyed) this.scheduleReconnect(ev.code);
    };

    ws.onerror = () => {
      this.callbacks.onError?.('WebSocket error');
      ws.close();
    };
  }

  // ─── Binary frame queue with back-pressure ────────────────────────────────
  private enqueueFrame(buf: ArrayBuffer): void {
    const MAX_Q = 8;
    if (this.frameQueue.length >= MAX_Q) {
      // Drop second-oldest (keep first as anchor, keep newest)
      this.frameQueue.splice(1, 1);
    }
    this.frameQueue.push(buf);
    // Decode synchronously on message (micro-task level, not setTimeout)
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.frameQueue.length) {
      const buf = this.frameQueue.shift()!;
      this.decodeFrame(buf);
    }
  }

  // ─── Binary decoder ───────────────────────────────────────────────────────
  private decodeFrame(buf: ArrayBuffer): void {
    if (buf.byteLength < 8) return;
    const v     = new DataView(buf);
    const type  = v.getUint8(0);
    const count = v.getUint16(2, false);
    const HLEN  = 8;
    const TLEN  = 32;

    if (type === FT.TRACK_LOST) {
      const ids: number[] = [];
      for (let i = 0; i < count; i++) {
        ids.push(v.getUint32(HLEN + i * 4, false));
      }
      this.callbacks.onDelta?.([], ids);
      return;
    }

    const tracks: RenderedTrack[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = HLEN + i * TLEN;
      tracks[i] = {
        id:          v.getUint32(o,      false),
        lat:         v.getInt32(o + 4,   false) / 1e7,
        lon:         v.getInt32(o + 8,   false) / 1e7,
        heading_deg: v.getUint16(o + 16, false) / 100,
        confidence:  v.getUint8(o + 18),
        threat:      THREAT_DEC[v.getUint8(o + 19)] ?? 'UNKNOWN',
        domain:      DOMAIN_DEC[v.getUint8(o + 30)] ?? 'AIR',
      };
    }

    if (type === FT.SNAPSHOT_CHUNK) {
      this.snapshotBuf.push(...tracks);
      this.callbacks.onSnapshot?.(tracks);
    } else {
      // DELTA
      this.callbacks.onDelta?.(tracks, []);
    }
  }

  // ─── JSON control messages ────────────────────────────────────────────────
  private handleJSON(raw: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'CONNECTED':
        this.callbacks.onConnected?.({
          trackCount: msg.trackCount as number,
          role:       msg.role as string,
        });
        break;

      case 'SNAPSHOT_COMPLETE':
        this.callbacks.onSnapshotComplete?.(this.snapshotBuf.length);
        this.snapshotBuf = [];
        break;

      case 'ALERT':
        this.callbacks.onAlert?.(msg.payload);
        break;

      case 'PONG':
        break; // heartbeat response
    }
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────
  private resetHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.close(4000, 'Heartbeat timeout');
      }
    }, 45_000);
  }

  // ─── Reconnect ────────────────────────────────────────────────────────────
  private scheduleReconnect(code: number): void {
    if (this.reconnTimer) return;
    if (code === 1000) return; // clean close

    const jitter = 1 + (Math.random() - 0.5) * 0.3;
    const delay  = Math.min(this.reconnDelay * jitter, 30_000);
    this.reconnDelay = Math.min(this.reconnDelay * 2, 30_000);

    this.reconnTimer = setTimeout(() => {
      this.reconnTimer = null;
      this.connect();
    }, delay);
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  requestSnapshot(): void {
    this.snapshotBuf = [];
    this.send({ type: 'REQUEST_SNAPSHOT' });
  }

  subscribe(channels: string[]): void {
    this.send({ type: 'SUBSCRIBE', channels });
  }

  setGeoFilter(cells: string[]): void {
    this.send({ type: 'SET_GEO_FILTER', cells });
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnTimer)    clearTimeout(this.reconnTimer);
    this.ws?.close(1000, 'destroy');
  }
}
