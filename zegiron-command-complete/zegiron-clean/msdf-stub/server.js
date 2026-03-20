/**
 * ZEGIRON Command — MSDF Stub Server
 * msdf-stub/server.js
 *
 * Simulates the C++ MSDF engine's TCP JSON stream.
 * Emits newline-delimited JSON at configurable Hz for N tracks.
 * No mock data in gateway — the gateway connects to THIS stub in dev/test.
 */

const net   = require('net');
const TRACK_COUNT = Number(process.env.TRACK_COUNT ?? 10000);
const HZ          = Number(process.env.UPDATE_HZ   ?? 10);
const PORT        = Number(process.env.PORT         ?? 9090);
const INTERVAL_MS = 1000 / HZ;

// Initialise track state
const tracks = Array.from({ length: TRACK_COUNT }, (_, i) => ({
  track_id:   i + 1,
  lat:        30 + Math.random() * 12,
  lon:        25 + Math.random() * 20,
  alt_ft:     Math.random() * 40000,
  speed_kts:  100 + Math.random() * 400,
  hdg_deg:    Math.random() * 360,
  conf:       60 + Math.floor(Math.random() * 40),
  threat:     ['UNKNOWN','FRIENDLY','NEUTRAL','HOSTILE'][
                i % 100 < 3 ? 3 : i % 100 < 20 ? 0 : i % 2],
  sensors:    i % 3 === 0 ? ['RADAR','EO_IR'] : ['AIS'],
  iff:        Math.floor(Math.random() * 5),
  rcs:        -10 + Math.random() * 30,
  domain:     i % 10 < 7 ? 'AIR' : i % 10 < 9 ? 'SURFACE' : 'LAND',
  ts:         Math.floor(Date.now() / 1000),
}));

const clients = new Set();

function tick() {
  if (!clients.size) return;

  // Update ~5% of tracks each tick
  const batch = [];
  for (let i = 0; i < Math.floor(TRACK_COUNT * 0.05); i++) {
    const t = tracks[Math.floor(Math.random() * TRACK_COUNT)];
    t.lat     += (Math.random() - 0.5) * 0.01;
    t.lon     += (Math.random() - 0.5) * 0.01;
    t.hdg_deg  = (t.hdg_deg + (Math.random() - 0.5) * 5 + 360) % 360;
    t.speed_kts += (Math.random() - 0.5) * 5;
    t.ts       = Math.floor(Date.now() / 1000);
    batch.push(t);
  }

  const line = JSON.stringify(batch) + '\n';

  for (const client of clients) {
    if (!client.writableEnded) {
      const ok = client.write(line);
      if (!ok) { /* backpressure — skip this client */ }
    }
  }
}

const server = net.createServer(sock => {
  console.log(`MSDF client connected from ${sock.remoteAddress}`);
  clients.add(sock);

  // Send all tracks on connect (initial snapshot)
  const snapshot = JSON.stringify(tracks) + '\n';
  sock.write(snapshot);

  sock.on('close',  () => { clients.delete(sock); });
  sock.on('error',  () => { clients.delete(sock); });
});

server.listen(PORT, () => {
  console.log(`MSDF stub listening on :${PORT} — ${TRACK_COUNT} tracks at ${HZ} Hz`);
  setInterval(tick, INTERVAL_MS);
});
