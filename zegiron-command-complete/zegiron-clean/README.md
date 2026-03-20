# ZEGIRON Command

> Production-grade real-time tactical display system.  
> 10,000 fused tracks · 5–10 Hz · WebSocket streaming · WebGL2 rendering · Docker

---

## Project Structure — All 28 Files

```
zegiron-command/
│
├── .env.example                        # All environment variables with defaults
├── docker-compose.yml                  # Full stack: nginx + gateway + frontend + redis + msdf-stub
│
├── nginx/
│   └── nginx.conf                      # Reverse proxy: HTTPS:443, WSS:8443, upstream routing
│
├── msdf-stub/
│   ├── Dockerfile                      # Node.js 20 Alpine
│   └── server.js                       # Simulates C++ MSDF engine — 10k tracks at 10 Hz over TCP
│
├── gateway/                            # Node.js WebSocket server
│   ├── Dockerfile                      # Multi-stage: build → alpine runtime
│   ├── package.json                    # uWebSockets.js, jsonwebtoken, redis, pino, prom-client
│   ├── tsconfig.json                   # ES2022, Node16 modules
│   └── src/
│       ├── index.ts                    # Cluster master + worker entry point
│       ├── types.ts                    # Shared type definitions (WSUserData, FramePayload, etc.)
│       ├── auth-middleware.ts          # JWT verify, token cache, Redis revocation, RBAC
│       ├── track-stream-handler.ts     # TCP MSDF ingestion, delta masks, binary encoder
│       └── websocket-server.ts        # µWS server, upgrade auth, snapshot streaming, broadcast
│
└── frontend/                           # React + WebGL2 browser app
    ├── Dockerfile                      # Multi-stage: Vite build → nginx static serve
    ├── package.json                    # React 18, Zustand, Vite
    ├── tsconfig.json                   # ES2022, DOM lib
    ├── vite.config.ts                  # Dev server with WS proxy to gateway:4000
    ├── index.html                      # HTML shell
    ├── nginx-spa.conf                  # nginx config for React SPA routing
    └── src/
        ├── main.tsx                    # React entry point
        ├── app/
        │   └── App.tsx                 # Root component
        ├── components/
        │   └── TacticalDisplay.tsx     # Main view: wires MapLayer + WS client + React overlays
        ├── tactical/
        │   ├── WebGLCanvas.ts          # WebGL2 context, ResizeObserver, shader utilities
        │   ├── TrackRenderer.ts        # Instanced renderer: 1 draw call for 10k tracks (GLSL SDF)
        │   └── MapLayer.ts             # rAF loop, pan/zoom, hit-test, cluster overlay
        ├── state/
        │   └── trackStore.ts           # Zustand Map<id,track>, O(1) updates, React isolation
        └── services/
            └── websocketClient.ts      # WS lifecycle, binary decoder, ring buffer, reconnect
```

**Total: 28 files** (26 code/config + README + Technical Reference doc)

---

## DO NOT MIX OLD AND NEW FILES

**Use ONLY this `zegiron-command/` folder. Do not combine with files from previous sessions.**

The previous sessions generated multiple versions of files like `BinaryProtocol.ts`, `WebGLInstancedRenderer.ts`, `trackStore.ts`, etc. with different APIs and assumptions. Mixing them will cause TypeScript errors and runtime failures.

| Previous session files | Status |
|---|---|
| `BinaryProtocol-v2.ts` | **Superseded** — encoding is now inline in `track-stream-handler.ts` |
| `WebGLInstancedRenderer.ts` | **Superseded** — replaced by `TrackRenderer.ts` |
| `cluster-worker.ts` / `cluster-master.ts` | **Superseded** — replaced by `index.ts` |
| `trackProcessor.worker.ts` | **Not used** — decode runs on main thread (fast enough) |
| `zegiron-manifests.yaml` | **Separate concern** — for Kubernetes; not needed for Docker Compose |

**This project is standalone and self-contained.**

---

## How to Build and Run

### Prerequisites

| Tool | Minimum Version | Install |
|---|---|---|
| Docker Desktop | 4.x | [docker.com](https://docker.com/get-started) |
| Docker Compose v2 | 2.x | Included with Docker Desktop |

That's it. No Node.js install needed to run with Docker.

---

### Step 1 — Environment Setup

```bash
cd zegiron-command
cp .env.example .env
```

Open `.env` and set a strong JWT secret (required):

```bash
# Generate a secure secret:
openssl rand -hex 32
```

Paste the result as `JWT_SECRET` in your `.env`:

```
JWT_SECRET=a8f3d2e1b9c4f7a6e2d8b1c3f5a9e4d7b2c6f1a4e8d3b7c2f9a5e1d6b4c8f2a3
```

---

### Step 2 — Build and Start (Full Stack)

```bash
# Start everything including the 10,000-track MSDF simulator
docker compose --profile dev up --build
```

First build takes 2–4 minutes (downloads Node.js + npm packages). Subsequent starts are under 10 seconds.

Expected output when healthy:

```
zegiron-msdf-stub  | MSDF stub listening on :9090 — 10000 tracks at 10 Hz
zegiron-gateway    | {"msg":"Worker ready","wid":"0","port":4000}
zegiron-frontend   | nginx: ready
zegiron-nginx      | [notice] start worker processes
```

---

### Step 3 — Open the UI

Open your browser at: **http://localhost**

You will see the tactical display connecting. It will show a "SYNCING" banner for ~3 seconds while the initial 10,000-track snapshot loads, then go live.

> **Note:** The browser shows a blank dark screen until you set an auth token (Step 4).

---

### Step 4 — Set an Auth Token

The UI requires a JWT in localStorage. Generate a dev token:

```bash
# Run this in a new terminal while the stack is running:
docker exec zegiron-gateway node -e "
const jwt = require('/app/node_modules/jsonwebtoken');
const token = jwt.sign(
  { sub: 'operator-001', role: 'OPERATOR', jti: require('crypto').randomUUID() },
  process.env.JWT_SECRET,
  { expiresIn: '8h', algorithm: 'HS256' }
);
console.log(token);
"
```

Copy the output token, then in your browser console (F12):

```javascript
localStorage.setItem('zegiron_token', 'PASTE_TOKEN_HERE');
location.reload();
```

The map will connect and tracks will appear.

---

### Stopping

```bash
docker compose down
```

To also remove volumes (Redis data):

```bash
docker compose down -v
```

---

## Local Development (No Docker)

For fast iteration with hot-reload:

```bash
# Terminal 1 — Redis
docker run --rm -p 6379:6379 redis:7.2-alpine

# Terminal 2 — MSDF stub (simulates 10k tracks)
cd msdf-stub && node server.js

# Terminal 3 — Gateway (hot-reload)
cd gateway
npm install
# Copy and edit env:
cp ../.env.example .env && echo "SINGLE_WORKER=true" >> .env
npm run dev
# Watching on http://localhost:4000

# Terminal 4 — Frontend (Vite hot-reload)
cd frontend
npm install
npm run dev
# Running on http://localhost:3000
# WS automatically proxied to localhost:4000
```

---

## Scaling

Each gateway container handles 2,000 WebSocket clients. Scale horizontally:

```bash
# Run 4 gateway instances (handles 8,000 clients)
docker compose --profile dev up --scale gateway=4 -d

# Verify load balancing
curl http://localhost/health
# Shows { clients: X } from whichever pod nginx routes to
```

NGINX uses `ip_hash` so reconnecting clients return to the same pod.

---

## Health Checks and Verification

```bash
# Gateway health (JSON)
curl http://localhost/health
# → {"status":"OK","clients":1,"tracks":10000,"uptime":42}

# Prometheus metrics
curl http://localhost:4000/metrics
# → zegiron_ws_clients 1
# → zegiron_tracks_sent_total 150000
# → zegiron_frame_latency_ms{...}

# Test WebSocket directly (install: npm i -g wscat)
TOKEN=$(docker exec zegiron-gateway node -e "...")  # from Step 4
wscat -c "ws://localhost:4000/ws?token=$TOKEN"
# → {"type":"CONNECTED","clientId":"...","trackCount":10000}
# → {"type":"SNAPSHOT_START","total":10000}
# → [binary frames]
# → {"type":"SNAPSHOT_COMPLETE","total":10000}
# → [binary delta every 100ms]
```

---

## Architecture at a Glance

```
C++ MSDF Engine (TCP :9090)
  │  JSON newline-delimited stream
  │  {"track_id":1042,"lat":36.4,"lon":33.8,"threat":"HOSTILE",...}
  ▼
Gateway (Node.js + µWebSockets.js)
  │  Parse → compute delta mask → encode 32-byte binary frame
  │  Publish to uWS rooms: track:all, track:geo:sv3x, alert:critical
  │  Max 2,000 clients per pod · JWT auth at upgrade · RBAC per channel
  ▼
Browser (React + WebGL2)
  │  Decode binary frames → Map<id, track>
  │  gl.drawArraysInstanced(TRIANGLES, 0, 6, 10000)  ← ONE draw call
  │  SDF symbols per domain (triangle=air, circle=surface, diamond=land)
  └  React renders only: stats bar, detail panel, sync indicator
```

### Binary Frame Format (32 bytes per track)

```
[0]    frame_type  0x01=SNAPSHOT 0x02=DELTA 0x03=CHUNK 0x04=LOST
[1]    flags       reserved
[2–3]  count       uint16 BE — track count
[4–7]  ts          uint32 BE — frame timestamp
--- per track (32 bytes × count) ---
[0–3]   id          uint32
[4–7]   lat_e7      int32  (degrees × 1e7)
[8–11]  lon_e7      int32
[12–13] alt_ft      int16
[14–15] speed_x10   uint16
[16–17] hdg_x100    uint16
[18]    confidence  uint8  0–100
[19]    threat      uint8  0=UNK 1=FRI 2=NEU 3=HOS
[20]    sensors     uint8  bitmask
[21]    iff         uint8
[22–25] ts          uint32
[26–27] rcs_x10     int16
[28–29] reserved
[30]    domain      uint8  0=AIR 1=SURF 2=SUB 3=LAND
[31]    delta_mask  uint8  changed-field bitmask
```

**Bandwidth:** JSON ≈ 3.5 MB/frame · Binary delta ≈ 9.6 KB/frame (99.7% reduction)

---

## Roles

| Role | Access |
|---|---|
| `READONLY` | track:all, alert:critical |
| `OPERATOR` | + track:geo:*, alert:high, sensor:health |
| `ANALYST` | + track:hostile, alert:*, sensor:*, replay:* |
| `SUPERVISOR` | + alert create, sensor config |
| `ADMIN` | All channels |

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JWT_SECRET` | **YES** | — | HMAC-SHA256 signing key (min 32 chars) |
| `REDIS_URL` | no | — | Token revocation store |
| `MSDF_HOST` | no | `msdf-stub` | MSDF engine hostname |
| `MSDF_PORT` | no | `9090` | MSDF TCP port |
| `MAX_CLIENTS` | no | `2000` | WS clients per gateway pod |
| `LOG_LEVEL` | no | `info` | trace/debug/info/warn/error |
| `VITE_WS_URL` | no | `ws://localhost:4000/ws` | Frontend WS endpoint (build-time) |
| `MOCK_TRACKS` | no | `10000` | Stub track count |
| `MOCK_HZ` | no | `10` | Stub update rate |

---

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Blank screen after token set | WS connection refused | Check `docker compose ps` — gateway must be `healthy` |
| "403 Forbidden" in WS | Invalid JWT | Regenerate token with correct `JWT_SECRET` from `.env` |
| `0 tracks` in health | MSDF not connected | Ensure `--profile dev` flag was used; check stub logs |
| SNAPSHOT_ABORTED | Client buffer full | Network too slow for 320 KB snapshot; use geo-filter |
| Container exits immediately | Missing `JWT_SECRET` | Edit `.env`, set `JWT_SECRET` before starting |
| Port 80 already in use | Another web server | Stop it, or change nginx port in `docker-compose.yml` |

---

*ZEGIRON Command v2.0 · TypeScript · React · WebGL2 · µWebSockets.js · Docker*
# Task-1
