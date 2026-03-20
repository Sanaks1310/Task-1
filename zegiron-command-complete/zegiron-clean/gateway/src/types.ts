/**
 * ZEGIRON Command — Shared Gateway Types
 * gateway/src/types.ts
 *
 * Central type definitions used across websocket-server.ts,
 * track-stream-handler.ts, and auth-middleware.ts.
 */

import type { Role } from './auth-middleware';

// ─── Per-socket user data (stored on every uWS WebSocket) ─────────────────────
export interface WSUserData {
  clientId:      string;   // UUID assigned on connect
  userId:        string;   // from JWT sub claim
  role:          Role;     // from JWT role claim
  rooms:         Set<string>; // currently subscribed uWS topics
  connectedAt:   number;   // Date.now() at open
  bytesSent:     number;   // cumulative bytes sent to this client
  droppedFrames: number;   // frames skipped due to backpressure
}

// ─── Frame emit payload from TrackStreamHandler ────────────────────────────────
export interface FramePayload {
  binary:     ArrayBuffer;            // encoded binary frame
  trackCount: number;                 // number of tracks in this frame
  geoCells:   Map<string, ArrayBuffer>; // cell key → per-cell binary frame
}

// ─── Broadcast target (room + binary frame) ───────────────────────────────────
export interface BroadcastTarget {
  room:   string;
  binary: ArrayBuffer;
}

// ─── MSDF raw JSON shape (what the C++ engine actually sends) ──────────────────
export interface MSDFRawTrack {
  track_id:   number;
  lat:        number;
  lon:        number;
  alt_ft?:    number;
  speed_kts?: number;
  hdg_deg?:   number;
  conf?:      number;
  threat?:    string;
  sensors?:   string[];
  iff?:       number;
  rcs?:       number;
  domain?:    string;
  ts?:        number;
}

// ─── Normalised internal track (after parsing MSDF JSON) ──────────────────────
export interface NormalisedTrack {
  id:        number;
  lat:       number;
  lon:       number;
  alt_ft:    number;
  speed_kts: number;
  hdg_deg:   number;
  conf:      number;
  threat:    string;
  sensors:   string[];
  iff:       number;
  rcs:       number;
  domain:    string;
  ts:        number;
  // Internal bookkeeping (not sent over wire)
  _deltaMask: number;
  _updatedAt: number;
  _geoCell:   string;
}

// ─── WebSocket client → gateway message shapes ────────────────────────────────
export interface ClientSubscribeMsg {
  type:     'SUBSCRIBE';
  channels: string[];
}
export interface ClientUnsubscribeMsg {
  type:     'UNSUBSCRIBE';
  channels: string[];
}
export interface ClientSnapshotMsg {
  type: 'REQUEST_SNAPSHOT';
}
export interface ClientGeoFilterMsg {
  type:  'SET_GEO_FILTER';
  cells: string[];
}
export interface ClientPingMsg {
  type: 'PING';
}

export type ClientMessage =
  | ClientSubscribeMsg
  | ClientUnsubscribeMsg
  | ClientSnapshotMsg
  | ClientGeoFilterMsg
  | ClientPingMsg;

// ─── Gateway → client JSON message shapes ────────────────────────────────────
export interface ServerConnectedMsg {
  type:       'CONNECTED';
  clientId:   string;
  role:       Role;
  trackCount: number;
  ts:         string;
}
export interface ServerHeartbeatMsg {
  type:    'HEARTBEAT';
  ts:      number;
  tracks:  number;
  clients: number;
}
export interface ServerSnapshotStartMsg {
  type:  'SNAPSHOT_START';
  total: number;
}
export interface ServerSnapshotCompleteMsg {
  type:  'SNAPSHOT_COMPLETE';
  total: number;
}
export interface ServerSnapshotAbortedMsg {
  type:   'SNAPSHOT_ABORTED';
  reason: string;
  sent:   number;
}
export interface ServerPongMsg {
  type: 'PONG';
  ts:   number;
}
export interface ServerAlertMsg {
  type:    'ALERT';
  payload: unknown;
}
export interface ServerErrorMsg {
  type:    'ERROR';
  code:    number;
  message: string;
  channel?: string;
}

export type ServerMessage =
  | ServerConnectedMsg
  | ServerHeartbeatMsg
  | ServerSnapshotStartMsg
  | ServerSnapshotCompleteMsg
  | ServerSnapshotAbortedMsg
  | ServerPongMsg
  | ServerAlertMsg
  | ServerErrorMsg;
