/**
 * ZEGIRON Command — WebGL Instanced Track Renderer
 * frontend/src/tactical/TrackRenderer.ts
 *
 * Renders up to 12,000 track symbols in a SINGLE gl.drawArraysInstanced() call.
 *
 * Instance buffer layout  (44 bytes / 11 floats per track):
 *   [0–1]  vec2  ndc_pos     — normalised device coords
 *   [2]    f32   rotation    — heading radians
 *   [3]    f32   scale       — pixel half-size
 *   [4–7]  vec4  color       — RGBA threat colour (0–1)
 *   [8]    f32   confidence  — 0–1
 *   [9]    f32   domain      — 0=AIR 1=SURF 2=SUB 3=LAND 4=SPACE
 *   [10]   f32   flags       — bit0=hostile bit1=selected
 *
 * Hot-path update strategy:
 *   Snapshot  → full buffer rebuild + bufferData
 *   Delta     → per-track bufferSubData (only dirty instances touched)
 *   Lost      → swap-remove compaction + full upload (infrequent)
 */

import type { WebGLCanvas } from './WebGLCanvas';

// ─── Instance constants ───────────────────────────────────────────────────────
const MAX_INST   = 12_000;
const FPI        = 11;             // floats per instance
const BPI        = FPI * 4;       // bytes per instance (44)

// ─── Threat colours (RGBA 0–1) ────────────────────────────────────────────────
const RGBA: Record<string, [number, number, number, number]> = {
  HOSTILE:  [1.000, 0.133, 0.267, 1.0],
  NEUTRAL:  [0.961, 0.651, 0.137, 1.0],
  FRIENDLY: [0.000, 0.898, 0.627, 1.0],
  UNKNOWN:  [0.482, 0.557, 0.631, 1.0],
};

const DOMAIN_F: Record<string, number> = {
  AIR: 0, SURFACE: 1, SUBSURFACE: 2, LAND: 3, SPACE: 4,
};

// ─── Vertex shader ────────────────────────────────────────────────────────────
const VERT = /* glsl */`#version 300 es
precision highp float;

// Per-instance (divisor = 1)
layout(location=0) in vec2  a_pos;
layout(location=1) in float a_rot;
layout(location=2) in float a_scale;
layout(location=3) in vec4  a_color;
layout(location=4) in float a_conf;
layout(location=5) in float a_domain;
layout(location=6) in float a_flags;

uniform float u_time;
uniform vec2  u_res;   // half canvas size in pixels

out vec4  v_color;
out vec2  v_uv;
out float v_domain;
out float v_pulse;
out float v_selected;

// 2-triangle quad (6 vertices, no index buffer needed)
const vec2 QUAD[6] = vec2[6](
  vec2(-1.0, 1.0), vec2(1.0, 1.0), vec2(-1.0,-1.0),
  vec2(-1.0,-1.0), vec2(1.0, 1.0), vec2( 1.0,-1.0)
);

void main() {
  // Frustum cull in vertex shader — displace offscreen, GPU clips for free
  if (abs(a_pos.x) > 1.1 || abs(a_pos.y) > 1.1) {
    gl_Position = vec4(9.0, 9.0, 9.0, 1.0);
    return;
  }

  bool hostile  = mod(a_flags,       2.0) >= 1.0;
  bool selected = mod(a_flags / 2.0, 2.0) >= 1.0;

  float pulse     = hostile  ? 1.0 + 0.18 * sin(u_time * 4.8 + float(gl_InstanceID) * 0.71) : 1.0;
  float selScale  = selected ? 1.4 : 1.0;
  float confScale = 0.65 + 0.35 * a_conf;
  float sz        = a_scale * confScale * pulse * selScale;

  vec2  local = QUAD[gl_VertexID];
  float c = cos(a_rot), s = sin(a_rot);
  vec2  rot = vec2(local.x * c - local.y * s,
                   local.x * s + local.y * c);

  gl_Position = vec4(a_pos + rot * (sz / u_res), 0.0, 1.0);

  v_color    = a_color;
  v_uv       = local;
  v_domain   = a_domain;
  v_pulse    = hostile  ? 0.5 + 0.5 * sin(u_time * 4.0 + float(gl_InstanceID) * 0.3) : 0.0;
  v_selected = selected ? 1.0 : 0.0;
}`;

// ─── Fragment shader (SDF symbol shapes) ─────────────────────────────────────
const FRAG = /* glsl */`#version 300 es
precision mediump float;

in vec4  v_color;
in vec2  v_uv;
in float v_domain;
in float v_pulse;
in float v_selected;

out vec4 fragColor;

float sdTri(vec2 p) {             // upward triangle — AIR
  p.y -= 0.08;
  vec2 q = abs(p);
  return max(q.x * 0.866 + p.y * 0.5, -p.y * 0.8) - 0.45;
}
float sdCircle(vec2 p)  { return length(p) - 0.65; }          // SURFACE
float sdTriDown(vec2 p) { return sdTri(vec2(p.x, -p.y)); }    // SUBSURFACE
float sdDiamond(vec2 p) { return abs(p.x) + abs(p.y) - 0.60;} // LAND
float sdRing(vec2 p, float r, float w) { return abs(length(p) - r) - w; }

void main() {
  vec2  p = v_uv;
  float d;
  int   dom = int(v_domain);
  if      (dom == 0) d = sdTri(p);
  else if (dom == 1) d = sdCircle(p);
  else if (dom == 2) d = sdTriDown(p);
  else if (dom == 3) d = sdDiamond(p);
  else               d = sdCircle(p);

  float aa    = fwidth(d);
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha < 0.01) discard;

  vec4 col = v_color;

  if (v_pulse > 0.01) {
    float rd = sdRing(p, 0.88 + v_pulse * 0.15, 0.045);
    float ra = (1.0 - smoothstep(-fwidth(rd), fwidth(rd), rd)) * v_pulse * 0.75;
    col   = mix(col, vec4(1.0, 0.13, 0.27, 1.0), ra);
    alpha = max(alpha, ra);
  }

  if (v_selected > 0.5) {
    float sd2 = sdRing(p, 1.05, 0.07);
    float sa  = (1.0 - smoothstep(-fwidth(sd2), fwidth(sd2), sd2)) * 0.9;
    col   = mix(col, vec4(0.0, 0.9, 1.0, 1.0), sa);
    alpha = max(alpha, sa);
  }

  fragColor = vec4(col.rgb, col.a * alpha);
}`;

// ─── Track shape fed to renderer ─────────────────────────────────────────────
export interface RenderedTrack {
  id:          number;
  lat:         number;
  lon:         number;
  heading_deg: number;
  threat:      string;
  confidence:  number;
  domain:      string;
}

export interface Viewport {
  minLat: number; maxLat: number;
  minLon: number; maxLon: number;
}

// ─── Renderer ────────────────────────────────────────────────────────────────
export class TrackRenderer {
  private prog:     WebGLProgram;
  private vao:      WebGLVertexArrayObject;
  private instBuf:  WebGLBuffer;
  private data:     Float32Array;
  private count     = 0;
  private idxMap    = new Map<number, number>(); // trackId → buffer index
  private uTime:    WebGLUniformLocation;
  private uRes:     WebGLUniformLocation;

  // Perf stats (readable from outside)
  drawMs   = 0;
  uploadMs = 0;

  constructor(private wc: WebGLCanvas) {
    const { gl } = wc;
    this.prog    = wc.linkProgram(VERT, FRAG);
    this.vao     = gl.createVertexArray()!;
    this.instBuf = gl.createBuffer()!;
    this.data    = new Float32Array(MAX_INST * FPI);
    this.uTime   = gl.getUniformLocation(this.prog, 'u_time')!;
    this.uRes    = gl.getUniformLocation(this.prog, 'u_res')!;
    this.initVAO();
  }

  // ── Full snapshot rebuild ──────────────────────────────────────────────────
  loadSnapshot(tracks: RenderedTrack[], vp: Viewport, selectedId: number | null): void {
    const t0 = performance.now();
    this.idxMap.clear();
    let idx = 0;
    for (const t of tracks) {
      if (idx >= MAX_INST) break;
      const ndc = project(t.lat, t.lon, vp);
      if (!visible(ndc)) continue;
      this.write(idx, t, ndc, t.id === selectedId);
      this.idxMap.set(t.id, idx++);
    }
    this.count = idx;
    this.uploadAll();
    this.uploadMs = performance.now() - t0;
  }

  // ── Delta update (hot path — runs at 10 Hz) ────────────────────────────────
  applyDelta(
    updated:    RenderedTrack[],
    lost:       number[],
    vp:         Viewport,
    selectedId: number | null,
  ): void {
    const t0  = performance.now();
    const { gl } = this.wc;

    // Remove lost tracks
    let needCompact = false;
    for (const id of lost) {
      if (this.idxMap.has(id)) { this.idxMap.delete(id); needCompact = true; }
    }
    if (needCompact) this.compact(vp, selectedId);

    // Patch or insert updated tracks
    for (const t of updated) {
      const ndc = project(t.lat, t.lon, vp);
      const existing = this.idxMap.get(t.id);

      if (existing !== undefined) {
        this.write(existing, t, ndc, t.id === selectedId);
        // Partial upload — only this instance's 44 bytes
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER,
          existing * BPI,
          this.data,
          existing * FPI,
          FPI,
        );
      } else if (visible(ndc) && this.count < MAX_INST) {
        const idx = this.count++;
        this.write(idx, t, ndc, t.id === selectedId);
        this.idxMap.set(t.id, idx);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER,
          idx * BPI,
          this.data,
          idx * FPI,
          FPI,
        );
      }
    }

    this.uploadMs = performance.now() - t0;
  }

  // ── Draw — ONE draw call for ALL tracks ───────────────────────────────────
  draw(ts: number): void {
    if (!this.count) return;
    const t0  = performance.now();
    const { gl, canvas } = this.wc;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform1f(this.uTime, ts / 1000);
    gl.uniform2f(this.uRes, canvas.width / 2, canvas.height / 2);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count); // ← THE hot line
    gl.bindVertexArray(null);

    this.drawMs = performance.now() - t0;
  }

  // ── Viewport pan/zoom: reproject all instances ────────────────────────────
  reproject(tracks: RenderedTrack[], vp: Viewport, selectedId: number | null): void {
    this.loadSnapshot(tracks, vp, selectedId);
  }

  // ─── Private ─────────────────────────────────────────────────────────────
  private write(
    idx:  number,
    t:    RenderedTrack,
    ndc:  { x: number; y: number },
    sel:  boolean,
  ): void {
    const b = idx * FPI;
    const d = this.data;
    const c = RGBA[t.threat] ?? RGBA.UNKNOWN;
    const hostile = t.threat === 'HOSTILE';
    d[b]    = ndc.x;
    d[b+1]  = ndc.y;
    d[b+2]  = (t.heading_deg * Math.PI) / 180;
    d[b+3]  = hostile ? 10.0 : 8.0;
    d[b+4]  = c[0]; d[b+5] = c[1]; d[b+6] = c[2]; d[b+7] = c[3];
    d[b+8]  = Math.max(0, Math.min(1, (t.confidence ?? 50) / 100));
    d[b+9]  = DOMAIN_F[t.domain ?? 'AIR'] ?? 0;
    d[b+10] = (hostile ? 1 : 0) | (sel ? 2 : 0);
  }

  private uploadAll(): void {
    const { gl } = this.wc;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * FPI);
  }

  /** Swap-remove compaction when tracks are lost */
  private compact(vp: Viewport, selectedId: number | null): void {
    const remaining = Array.from(this.idxMap.keys());
    const newMap    = new Map<number, number>();
    let   newCount  = 0;
    for (const id of remaining) {
      const old = this.idxMap.get(id)!;
      const dst = newCount * FPI;
      const src = old * FPI;
      if (src !== dst) this.data.copyWithin(dst, src, src + FPI);
      newMap.set(id, newCount++);
    }
    this.idxMap = newMap;
    this.count  = newCount;
    this.uploadAll();
  }

  private initVAO(): void {
    const { gl } = this.wc;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const attr = (loc: number, size: number, off: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, BPI, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(0, 2, 0);  attr(1, 1, 8);  attr(2, 1, 12);
    attr(3, 4, 16); attr(4, 1, 32); attr(5, 1, 36); attr(6, 1, 40);
    gl.bindVertexArray(null);
  }
}

// ─── Geo → NDC projection ─────────────────────────────────────────────────────
export function project(
  lat: number, lon: number, vp: Viewport,
): { x: number; y: number } {
  return {
    x: ((lon - vp.minLon) / (vp.maxLon - vp.minLon)) * 2 - 1,
    y: ((lat - vp.minLat) / (vp.maxLat - vp.minLat)) * 2 - 1,
  };
}

function visible(ndc: { x: number; y: number }, m = 0.05): boolean {
  return ndc.x > -1-m && ndc.x < 1+m && ndc.y > -1-m && ndc.y < 1+m;
}
