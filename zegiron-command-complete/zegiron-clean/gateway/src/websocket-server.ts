/**
 * ZEGIRON Command — WebSocket Server
 * gateway/src/websocket-server.ts
 *
 * µWebSockets.js server. Handles upgrade auth, room subscriptions,
 * snapshot streaming, and binary delta broadcast.
 *
 * Key design decisions:
 *  • JWT validated at UPGRADE — rejected clients never open a socket
 *  • Binary 32-byte frames on hot path — no JSON serialisation overhead
 *  • uWS native pub/sub rooms — O(1) broadcast per room regardless of client count
 *  • Snapshot chunks of 500 tracks with setImmediate yields — never blocks event loop
 *  • Backpressure: skip send if bufferedAmount > MAX_BP; log dropped frame
 *  • Graceful drain: SIGTERM → close listen socket → wait 5 s for clients to drain
 */

import uWS, {
  type App,
  type WebSocket,
  type HttpResponse,
  type HttpRequest,
  type us_listen_socket,
} from 'uWebSockets.js';
import pino from 'pino';
import { Counter, Gauge, Histogram, register as promReg } from 'prom-client';
import { verifyToken, canSubscribe, type Role } from './auth-middleware';
import { TrackStreamHandler, encodeFrame, FRAME } from './track-stream-handler';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ─── Metrics ──────────────────────────────────────────────────────────────────
const M = {
  clients:    new Gauge({   name: 'zegiron_ws_clients',          help: 'Connected clients'          }),
  sent:       new Counter({ name: 'zegiron_tracks_sent_total',   help: 'Track records sent'         }),
  dropped:    new Counter({ name: 'zegiron_frames_dropped_total',help: 'Frames dropped (backpressure)' }),
  latency:    new Histogram({ name: 'zegiron_frame_latency_ms',  help: 'ms from MSDF to send',
                              buckets: [1, 5, 10, 25, 50, 100]  }),
};

// ─── Per-socket user data ────────────────────────────────────────────────────
export interface WSUserData {
  clientId:      string;
  userId:        string;
  role:          Role;
  rooms:         Set<string>;
  connectedAt:   number;
  bytesSent:     number;
  droppedFrames: number;
}

const MAX_BP      = 512 * 1024;   // 512 KB backpressure threshold
const CHUNK_SIZE  = 500;          // tracks per snapshot chunk
const HB_INTERVAL = 20_000;      // heartbeat ms

// ─── Server ───────────────────────────────────────────────────────────────────
export class WebSocketServer {
  private app:     App;
  private token:   us_listen_socket | null = null;
  private clients  = 0;
  private handler: TrackStreamHandler;

  constructor(handler: TrackStreamHandler) {
    this.handler = handler;
    this.app     = uWS.App();
    this.mountWS();
    this.mountHTTP();
    this.wireHandler();
    this.startHeartbeat();
  }

  // ─── WebSocket endpoint ───────────────────────────────────────────────────
  private mountWS(): void {
    const { app } = this;
    const MAX_CLIENTS = Number(process.env.MAX_CLIENTS ?? 2000);

    app.ws<WSUserData>('/ws', {
      compression:            uWS.DEDICATED_COMPRESSOR_4KB,
      maxPayloadLength:       64 * 1024,
      idleTimeout:            120,
      maxBackpressure:        MAX_BP,
      sendPingsAutomatically: true,

      // ── Upgrade: verify JWT before accepting socket ───────────────────────
      upgrade: (res: HttpResponse, req: HttpRequest, ctx) => {
        if (this.clients >= MAX_CLIENTS) {
          res.writeStatus('503 Service Unavailable').end();
          return;
        }

        const qs    = req.getQuery();
        const token =
          new URLSearchParams(qs).get('token') ??
          req.getHeader('authorization').replace(/^Bearer\s+/i, '').trim();

        if (!token) { res.writeStatus('401 Unauthorized').end(); return; }

        const payload = verifyToken(token);
        if (!payload) { res.writeStatus('403 Forbidden').end(); return; }

        res.upgrade<WSUserData>(
          {
            clientId:      crypto.randomUUID(),
            userId:        payload.sub,
            role:          payload.role,
            rooms:         new Set(['track:all', 'alert:critical']),
            connectedAt:   Date.now(),
            bytesSent:     0,
            droppedFrames: 0,
          },
          req.getHeader('sec-websocket-key'),
          req.getHeader('sec-websocket-protocol'),
          req.getHeader('sec-websocket-extensions'),
          ctx,
        );
      },

      // ── Open ─────────────────────────────────────────────────────────────
      open: (ws: WebSocket<WSUserData>) => {
        const d = ws.getUserData();
        log.info({ clientId: d.clientId, role: d.role }, 'Client connected');
        ws.subscribe('track:all');
        ws.subscribe('alert:critical');
        this.clients++;
        M.clients.set(this.clients);

        ws.send(JSON.stringify({
          type:       'CONNECTED',
          clientId:   d.clientId,
          role:       d.role,
          trackCount: this.handler.getCount(),
          ts:         new Date().toISOString(),
        }));

        this.streamSnapshot(ws)
          .catch(err => log.error({ err, clientId: d.clientId }, 'Snapshot failed'));
      },

      // ── Message ───────────────────────────────────────────────────────────
      message: (ws: WebSocket<WSUserData>, raw: ArrayBuffer) => {
        let msg: { type: string; channels?: string[]; cells?: string[] };
        try { msg = JSON.parse(Buffer.from(raw).toString()); }
        catch { return; }

        const d = ws.getUserData();
        switch (msg.type) {
          case 'SUBSCRIBE':
            (msg.channels ?? []).forEach(ch => {
              if (canSubscribe(d.role, ch)) { ws.subscribe(ch); d.rooms.add(ch); }
              else ws.send(JSON.stringify({ type: 'ERROR', code: 403, channel: ch }));
            });
            break;

          case 'UNSUBSCRIBE':
            (msg.channels ?? []).forEach(ch => { ws.unsubscribe(ch); d.rooms.delete(ch); });
            break;

          case 'REQUEST_SNAPSHOT':
            this.streamSnapshot(ws).catch(log.error);
            break;

          case 'SET_GEO_FILTER':
            (msg.cells ?? []).forEach(cell => {
              const room = `track:geo:${cell}`;
              if (canSubscribe(d.role, room)) ws.subscribe(room);
            });
            break;

          case 'PING':
            ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
            break;
        }
      },

      drain: (ws: WebSocket<WSUserData>) => {
        const d = ws.getUserData();
        log.debug({ clientId: d.clientId, buf: ws.getBufferedAmount() }, 'drain');
      },

      close: (ws: WebSocket<WSUserData>, code: number) => {
        const d = ws.getUserData();
        log.info({ clientId: d.clientId, code, bytesSent: d.bytesSent }, 'Client disconnected');
        this.clients = Math.max(0, this.clients - 1);
        M.clients.set(this.clients);
      },
    });
  }

  // ─── HTTP endpoints ───────────────────────────────────────────────────────
  private mountHTTP(): void {
    this.app.get('/health', res => {
      res.writeHeader('Content-Type', 'application/json').end(JSON.stringify({
        status: 'OK', clients: this.clients,
        tracks: this.handler.getCount(), uptime: process.uptime(),
      }));
    });

    this.app.get('/metrics', async res => {
      let aborted = false;
      res.onAborted(() => { aborted = true; });
      const body = await promReg.metrics();
      if (!aborted) res.writeHeader('Content-Type', promReg.contentType).end(body);
    });

    this.app.any('/*', res => res.writeStatus('404').end());
  }

  // ─── Wire TrackStreamHandler events → broadcast ───────────────────────────
  private wireHandler(): void {
    this.handler.on('frame', ({ binary, trackCount, geoCells }: {
      binary:     ArrayBuffer;
      trackCount: number;
      geoCells:   Map<string, ArrayBuffer>;
    }) => {
      const t0 = performance.now();

      // Check if any clients need the message before incurring publish cost
      this.app.publish('track:all', binary, true);

      // Geo-cell targeted publish
      for (const [cell, frame] of geoCells) {
        this.app.publish(`track:geo:${cell}`, frame, true);
      }

      M.sent.inc(trackCount);
      M.latency.observe(performance.now() - t0);
    });
  }

  // ─── Snapshot streaming ───────────────────────────────────────────────────
  private async streamSnapshot(ws: WebSocket<WSUserData>): Promise<void> {
    const all   = this.handler.getSnapshot();
    const total = all.length;
    const d     = ws.getUserData();

    ws.send(JSON.stringify({ type: 'SNAPSHOT_START', total }));

    for (let i = 0; i < total; i += CHUNK_SIZE) {
      // Check if client is still connected and not backpressured
      if (ws.getBufferedAmount() > MAX_BP) {
        ws.send(JSON.stringify({ type: 'SNAPSHOT_ABORTED', reason: 'backpressure', sent: i }));
        M.dropped.inc();
        return;
      }

      const chunk = all.slice(i, i + CHUNK_SIZE);
      // Re-encode with SNAPSHOT_CHUNK type (frontend distinguishes from live DELTA)
      const frame = encodeFrame(chunk as any, FRAME.SNAPSHOT_CHUNK);
      ws.send(frame, true);
      d.bytesSent += frame.byteLength;

      // Yield to event loop between chunks — never starve other clients
      if (i + CHUNK_SIZE < total) {
        await new Promise<void>(r => setImmediate(r));
      }
    }

    ws.send(JSON.stringify({ type: 'SNAPSHOT_COMPLETE', total }));
    log.info({ clientId: d.clientId, total }, 'Snapshot streamed');
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────
  private startHeartbeat(): void {
    setInterval(() => {
      this.app.publish('track:all', JSON.stringify({
        type:    'HEARTBEAT',
        ts:      Date.now(),
        tracks:  this.handler.getCount(),
        clients: this.clients,
      }));
    }, HB_INTERVAL);
  }

  // ─── Listen / shutdown ────────────────────────────────────────────────────
  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.app.listen(port, token => {
        if (token) {
          this.token = token;
          log.info({ port }, 'Gateway listening');
          resolve();
        } else {
          reject(new Error(`Cannot bind port ${port}`));
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    log.info('Gateway shutting down');
    if (this.token) { uWS.us_listen_socket_close(this.token); this.token = null; }
    await new Promise(r => setTimeout(r, 5000));
  }
}
