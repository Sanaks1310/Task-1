/**
 * ZEGIRON Command — Gateway Entry Point
 * gateway/src/index.ts
 *
 * Cluster mode: one OS process per CPU core, each running an independent
 * uWS server. NGINX does L4 load balancing with ip_hash for WS stickiness.
 *
 * Single-worker mode: set SINGLE_WORKER=true (useful for local dev / containers
 * where the orchestrator controls replica count externally).
 */

import cluster from 'node:cluster';
import os      from 'node:os';
import process from 'node:process';
import pino    from 'pino';
import { WebSocketServer } from './websocket-server';
import { TrackStreamHandler } from './track-stream-handler';

const log         = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT        = Number(process.env.PORT ?? 4000);
const NUM_WORKERS = Number(process.env.WORKERS ?? os.cpus().length);
const SINGLE      = process.env.SINGLE_WORKER === 'true';

// ─── Cluster Master ───────────────────────────────────────────────────────────
if (cluster.isPrimary && !SINGLE) {
  log.info({ workers: NUM_WORKERS, pid: process.pid }, 'ZEGIRON Gateway master starting');

  for (let i = 0; i < NUM_WORKERS; i++) {
    const w = cluster.fork({ WORKER_ID: String(i) });
    log.info({ id: w.id }, 'Worker forked');
  }

  cluster.on('exit', (worker, code, signal) => {
    log.warn({ id: worker.id, code, signal }, 'Worker exited — respawning');
    cluster.fork();
  });

  process.on('SIGTERM', () => {
    log.info('Master SIGTERM — draining workers');
    for (const w of Object.values(cluster.workers ?? {})) w?.send('shutdown');
    setTimeout(() => process.exit(0), 8000);
  });

} else {
  // ─── Cluster Worker ─────────────────────────────────────────────────────
  async function start(): Promise<void> {
    const wid     = process.env.WORKER_ID ?? '0';
    const handler = new TrackStreamHandler();
    const server  = new WebSocketServer(handler);

    // In cluster mode each worker binds the same port — OS load-balances.
    // In SINGLE_WORKER mode only one process runs.
    await server.listen(PORT);
    log.info({ wid, port: PORT, pid: process.pid }, 'Worker ready');

    const shutdown = async (sig: string) => {
      log.info({ sig, wid }, 'Worker shutting down');
      await server.shutdown();
      process.exit(0);
    };

    process.on('SIGTERM',  () => shutdown('SIGTERM'));
    process.on('SIGINT',   () => shutdown('SIGINT'));
    process.on('message',  msg => { if (msg === 'shutdown') shutdown('master'); });
  }

  start().catch(err => {
    log.fatal({ err }, 'Worker startup failed');
    process.exit(1);
  });
}
