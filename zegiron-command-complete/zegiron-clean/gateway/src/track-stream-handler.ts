/**
 * ZEGIRON Command — Track Stream Handler
 * gateway/src/track-stream-handler.ts
 *
 * Ingests a newline-delimited JSON stream from the C++ MSDF engine over TCP,
 * computes per-field deltas, encodes 32-byte binary frames, and emits them
 * as Node.js events for the WebSocket server to broadcast.
 *
 * Delta strategy:
 *   - State stored in Map<trackId, Track>
 *   - Per-field comparison using bitmask (_deltaMask)
 *   - Only changed fields flagged — receiver patches only those fields
 *   - Unchanged tracks NOT included in frame (bandwidth = 0 for static tracks)
 *   - TTL-based pruning emits TRACK_LOST frame for departed tracks
 *
 * Backpressure:
 *   - TCP socket paused when pending queue > HIGH_WATER_MARK
 *   - Resumed when queue drops below LOW_WATER_MARK
 *   - 1 MB line-buffer overflow guard → reset + reconnect
 *
 * MSDF JSON fields (one object per newline):
 *   track_id  : number   — unique track identifier
 *   lat       : number   — latitude degrees
 *   lon       : number   — longitude degrees
 *   alt_ft    : number   — altitude feet (optional)
 *   speed_kts : number   — speed knots (optional)
 *   hdg_deg   : number   — heading degrees 0–360 (optional)
 *   conf      : number   — confidence 0–100
 *   threat    : string   — UNKNOWN|FRIENDLY|NEUTRAL|HOSTILE
 *   sensors   : string[] — ["RADAR","EO_IR","AIS","PASSIVE_RF"]
 *   iff       : number   — IFF mode 0–5 (optional)
 *   rcs       : number   — RCS dBsm (optional)
 *   domain    : string   — AIR|SURFACE|SUBSURFACE|LAND|SPACE
 *   ts        : number   — unix timestamp seconds
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import pino from 'pino';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ─── Binary frame type constants ─────────────────────────────────────────────
export const FRAME = {
  FULL_SNAPSHOT:   0x01,
  DELTA:           0x02,
  SNAPSHOT_CHUNK:  0x03,
  TRACK_LOST:      0x04,
} as const;

// ─── Delta mask bits ──────────────────────────────────────────────────────────
export const DELTA_BITS = {
  POSITION:  0x01,
  ALTITUDE:  0x02,
  VELOCITY:  0x04,
  THREAT:    0x08,
  SENSORS:   0x10,
  IFF:       0x20,
  TIMESTAMP: 0x40,
  ALL:       0xFF,
} as const;

// ─── Config ───────────────────────────────────────────────────────────────────
const CFG = {
  MSDF_HOST:      process.env.MSDF_HOST     ?? 'msdf-engine',
  MSDF_PORT:      Number(process.env.MSDF_PORT ?? 9090),
  RECONNECT_BASE: 1_000,
  RECONNECT_MAX:  30_000,
  TRACK_TTL:      30_000,    // tracks absent > 30 s → TRACK_LOST
  PRUNE_INTERVAL: 5_000,
  FLUSH_INTERVAL: 100,       // batch at 10 Hz max
  MAX_LINE_BUF:   1_048_576, // 1 MB
  HWM:            10_000,    // high watermark (pending tracks)
  LWM:            2_000,     // low watermark
} as const;

// ─── Internal track shape ─────────────────────────────────────────────────────
interface Track {
  id:           number;
  lat:          number;
  lon:          number;
  alt_ft:       number;
  speed_kts:    number;
  hdg_deg:      number;
  conf:         number;
  threat:       string;
  sensors:      string[];
  iff:          number;
  rcs:          number;
  domain:       string;
  ts:           number;
  _deltaMask:   number;
  _updatedAt:   number;
  _geoCell:     string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export class TrackStreamHandler extends EventEmitter {
  private state      = new Map<number, Track>();
  private pending:   Track[] = [];
  private lineBuf    = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnDelay = CFG.RECONNECT_BASE;
  private tcpSocket:  net.Socket | null = null;
  private paused     = false;

  constructor() {
    super();
    setInterval(() => this.prune(), CFG.PRUNE_INTERVAL);
    this.connect();
  }

  // ─── TCP connect ──────────────────────────────────────────────────────────
  private connect(): void {
    log.info({ host: CFG.MSDF_HOST, port: CFG.MSDF_PORT }, 'Connecting to MSDF engine');
    const sock = new net.Socket();
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);

    sock.connect(CFG.MSDF_PORT, CFG.MSDF_HOST, () => {
      log.info('MSDF TCP connected');
      this.reconnDelay = CFG.RECONNECT_BASE;
      this.tcpSocket   = sock;
      this.emit('connected');
    });

    sock.on('data', (chunk: Buffer) => {
      this.lineBuf += chunk.toString('utf8');

      // Guard runaway buffer
      if (this.lineBuf.length > CFG.MAX_LINE_BUF) {
        log.error('Line buffer overflow — reconnecting');
        this.lineBuf = '';
        sock.destroy();
        return;
      }

      // Parse all complete lines
      let nl: number;
      while ((nl = this.lineBuf.indexOf('\n')) !== -1) {
        const line = this.lineBuf.slice(0, nl).trim();
        this.lineBuf = this.lineBuf.slice(nl + 1);
        if (line) this.parseLine(line);
      }

      // Backpressure: pause TCP if queue is large
      if (this.pending.length > CFG.HWM && !this.paused) {
        sock.pause();
        this.paused = true;
        log.warn({ queueDepth: this.pending.length }, 'TCP paused (backpressure)');
      }
    });

    sock.on('close', () => {
      log.warn('MSDF TCP closed');
      this.tcpSocket = null;
      this.scheduleReconnect();
    });

    sock.on('error', err => {
      log.error({ err: err.message }, 'MSDF socket error');
      sock.destroy();
    });
  }

  // ─── Parse one JSON line ──────────────────────────────────────────────────
  private parseLine(line: string): void {
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { log.warn({ line: line.slice(0, 80) }, 'MSDF JSON parse error'); return; }

    const batch = Array.isArray(raw) ? raw : [raw];
    for (const item of batch) {
      const t = this.normalise(item);
      if (t) this.pending.push(t);
    }

    this.scheduleFlush();
  }

  // ─── Normalise raw MSDF JSON ──────────────────────────────────────────────
  private normalise(raw: unknown): Track | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.track_id !== 'number') return null;
    if (typeof r.lat !== 'number' || typeof r.lon !== 'number') return null;

    return {
      id:        r.track_id as number,
      lat:       r.lat as number,
      lon:       r.lon as number,
      alt_ft:    typeof r.alt_ft    === 'number' ? r.alt_ft    : 0,
      speed_kts: typeof r.speed_kts === 'number' ? r.speed_kts : 0,
      hdg_deg:   typeof r.hdg_deg   === 'number' ? r.hdg_deg   : 0,
      conf:      typeof r.conf      === 'number' ? Math.round(r.conf as number) : 0,
      threat:    typeof r.threat    === 'string' ? (r.threat as string).toUpperCase() : 'UNKNOWN',
      sensors:   Array.isArray(r.sensors) ? (r.sensors as string[]) : [],
      iff:       typeof r.iff       === 'number' ? r.iff       : 0,
      rcs:       typeof r.rcs       === 'number' ? r.rcs       : 0,
      domain:    typeof r.domain    === 'string' ? r.domain    : 'AIR',
      ts:        typeof r.ts        === 'number' ? r.ts        : Math.floor(Date.now() / 1000),
      _deltaMask: DELTA_BITS.ALL,
      _updatedAt: Date.now(),
      _geoCell:   geoHash4(
        typeof r.lat === 'number' ? r.lat : 0,
        typeof r.lon === 'number' ? r.lon : 0,
      ),
    };
  }

  // ─── Flush: delta → binary frame → emit ──────────────────────────────────
  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, CFG.FLUSH_INTERVAL);
  }

  private flush(): void {
    if (!this.pending.length) return;

    // Resume TCP if we've drained enough
    if (this.paused && this.pending.length < CFG.LWM) {
      this.tcpSocket?.resume();
      this.paused = false;
      log.info('TCP resumed');
    }

    const incoming = this.pending.splice(0);
    const changed: Track[] = [];
    const geoCells = new Map<string, Track[]>();

    for (const t of incoming) {
      const prev = this.state.get(t.id);
      const mask = this.deltaMask(t, prev);
      if (mask === 0) continue;  // nothing changed — skip

      t._deltaMask = mask;
      t._updatedAt = Date.now();
      t._geoCell   = geoHash4(t.lat, t.lon);
      this.state.set(t.id, t);
      changed.push(t);

      if (!geoCells.has(t._geoCell)) geoCells.set(t._geoCell, []);
      geoCells.get(t._geoCell)!.push(t);
    }

    if (!changed.length) return;

    const frame = encodeFrame(changed, FRAME.DELTA);
    const cellFrames = new Map<string, ArrayBuffer>();
    for (const [cell, tracks] of geoCells) {
      cellFrames.set(cell, encodeFrame(tracks, FRAME.DELTA));
    }

    this.emit('frame', { binary: frame, trackCount: changed.length, geoCells: cellFrames });
  }

  // ─── Per-field delta mask ─────────────────────────────────────────────────
  private deltaMask(curr: Track, prev: Track | undefined): number {
    if (!prev) return DELTA_BITS.ALL;
    let m = 0;
    const EPS = 0.00001;  // ~1 m at equator
    if (Math.abs(curr.lat - prev.lat) > EPS || Math.abs(curr.lon - prev.lon) > EPS)
      m |= DELTA_BITS.POSITION;
    if (curr.alt_ft    !== prev.alt_ft)   m |= DELTA_BITS.ALTITUDE;
    if (curr.speed_kts !== prev.speed_kts || curr.hdg_deg !== prev.hdg_deg)
      m |= DELTA_BITS.VELOCITY;
    if (curr.threat    !== prev.threat || curr.conf !== prev.conf)
      m |= DELTA_BITS.THREAT;
    if (!arrEq(curr.sensors, prev.sensors)) m |= DELTA_BITS.SENSORS;
    if (curr.iff       !== prev.iff)     m |= DELTA_BITS.IFF;
    if (curr.ts        !== prev.ts)      m |= DELTA_BITS.TIMESTAMP;
    return m;
  }

  // ─── TTL prune ────────────────────────────────────────────────────────────
  private prune(): void {
    const cutoff  = Date.now() - CFG.TRACK_TTL;
    const lostIds: number[] = [];
    for (const [id, t] of this.state) {
      if (t._updatedAt < cutoff) { lostIds.push(id); this.state.delete(id); }
    }
    if (lostIds.length) {
      const frame = encodeLostFrame(lostIds);
      this.emit('frame', { binary: frame, trackCount: lostIds.length, geoCells: new Map() });
      log.info({ count: lostIds.length }, 'Pruned stale tracks');
    }
  }

  // ─── Reconnect with exponential backoff + jitter ──────────────────────────
  private scheduleReconnect(): void {
    const jitter = 1 + (Math.random() - 0.5) * 0.3;
    const delay  = Math.min(this.reconnDelay * jitter, CFG.RECONNECT_MAX);
    this.reconnDelay = Math.min(this.reconnDelay * 2, CFG.RECONNECT_MAX);
    log.info({ ms: Math.round(delay) }, 'MSDF reconnect scheduled');
    setTimeout(() => this.connect(), delay);
  }

  // ─── Public accessors ────────────────────────────────────────────────────
  getCount(): number { return this.state.size; }

  getSnapshot(): Track[] { return Array.from(this.state.values()); }
}

// ─── Binary frame encoder ────────────────────────────────────────────────────

export function encodeFrame(tracks: Track[], type: number): ArrayBuffer {
  const HEADER  = 8;
  const STRIDE  = 32;
  const buf     = new ArrayBuffer(HEADER + tracks.length * STRIDE);
  const v       = new DataView(buf);
  const THREAT  = { UNKNOWN: 0, FRIENDLY: 1, NEUTRAL: 2, HOSTILE: 3 } as Record<string, number>;
  const DOMAIN  = { AIR: 0, SURFACE: 1, SUBSURFACE: 2, LAND: 3, SPACE: 4 } as Record<string, number>;

  v.setUint8(0,  type);
  v.setUint8(1,  0);
  v.setUint16(2, tracks.length, false);
  v.setUint32(4, Math.floor(Date.now() / 1000), false);

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]!;
    const o = HEADER + i * STRIDE;
    let sensors = 0;
    if (t.sensors.includes('RADAR'))      sensors |= 0x01;
    if (t.sensors.includes('EO_IR'))      sensors |= 0x02;
    if (t.sensors.includes('AIS'))        sensors |= 0x04;
    if (t.sensors.includes('PASSIVE_RF')) sensors |= 0x08;

    v.setUint32(o,      t.id,                               false);
    v.setInt32(o + 4,   Math.round(t.lat  * 1e7),           false);
    v.setInt32(o + 8,   Math.round(t.lon  * 1e7),           false);
    v.setInt16(o + 12,  t.alt_ft,                           false);
    v.setUint16(o + 14, Math.round(t.speed_kts * 10),       false);
    v.setUint16(o + 16, Math.round(t.hdg_deg   * 100) % 36000, false);
    v.setUint8(o + 18,  t.conf);
    v.setUint8(o + 19,  THREAT[t.threat] ?? 0);
    v.setUint8(o + 20,  sensors);
    v.setUint8(o + 21,  t.iff);
    v.setUint32(o + 22, t.ts,                               false);
    v.setInt16(o + 26,  Math.round(t.rcs   * 10),           false);
    v.setUint8(o + 30,  DOMAIN[t.domain] ?? 0);
    v.setUint8(o + 31,  t._deltaMask);
  }
  return buf;
}

export function encodeLostFrame(ids: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(8 + ids.length * 4);
  const v   = new DataView(buf);
  v.setUint8(0,  0x04);  // TRACK_LOST
  v.setUint16(2, ids.length, false);
  v.setUint32(4, Math.floor(Date.now() / 1000), false);
  ids.forEach((id, i) => v.setUint32(8 + i * 4, id, false));
  return buf;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function geoHash4(lat: number, lon: number): string {
  const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let [minLat, maxLat, minLon, maxLon] = [-90, 90, -180, 180];
  let [hash, bits, even, res] = [0, 0, true, ''];
  while (res.length < 4) {
    if (even) {
      const mid = (minLon + maxLon) / 2;
      lon > mid ? (hash = (hash << 1) | 1, minLon = mid) : (hash <<= 1, maxLon = mid);
    } else {
      const mid = (minLat + maxLat) / 2;
      lat > mid ? (hash = (hash << 1) | 1, minLat = mid) : (hash <<= 1, maxLat = mid);
    }
    even = !even;
    if (++bits === 5) { res += B32[hash]!; bits = 0; hash = 0; }
  }
  return res;
}
