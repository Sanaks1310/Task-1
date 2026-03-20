/**
 * ZEGIRON Command — Map Layer
 * frontend/src/tactical/MapLayer.ts
 *
 * Ties together WebGLCanvas + TrackRenderer + pointer interaction.
 *
 * Responsibilities:
 *   • Own the rAF loop (calls renderer.draw every frame)
 *   • Pan via pointer drag
 *   • Zoom via wheel
 *   • Click hit-test: find nearest track to cursor
 *   • Canvas2D overlay for cluster bubbles + grid lines
 *   • Pause rAF when tab is hidden
 */

import { WebGLCanvas } from './WebGLCanvas';
import { TrackRenderer, project, type RenderedTrack, type Viewport } from './TrackRenderer';

export interface MapLayerOptions {
  container:  HTMLElement;
  onSelect?:  (id: number | null) => void;
  onViewport?: (vp: Viewport) => void;
}

const INITIAL_VP: Viewport = { minLat: 30, maxLat: 42, minLon: 25, maxLon: 45 };

export class MapLayer {
  private wc:       WebGLCanvas;
  private renderer: TrackRenderer;
  private overlay:  HTMLCanvasElement;
  private rafId     = 0;

  private vp         = { ...INITIAL_VP };
  private isDragging = false;
  private dragOrigin = { x: 0, y: 0, ...INITIAL_VP };

  private allTracks: RenderedTrack[] = [];
  private selectedId: number | null   = null;

  private onSelect:   MapLayerOptions['onSelect'];
  private onViewport: MapLayerOptions['onViewport'];

  constructor(opts: MapLayerOptions) {
    this.onSelect   = opts.onSelect;
    this.onViewport = opts.onViewport;

    this.wc       = new WebGLCanvas(opts.container);
    this.renderer = new TrackRenderer(this.wc);

    // Canvas2D cluster / grid overlay
    this.overlay = document.createElement('canvas');
    Object.assign(this.overlay.style, {
      position: 'absolute', inset: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none',
    });
    opts.container.appendChild(this.overlay);

    this.wc.onResize((w, h) => {
      this.overlay.width  = w;
      this.overlay.height = h;
    });

    this.attachPointerEvents(opts.container);
    this.startLoop();
  }

  // ─── Track data updates ───────────────────────────────────────────────────

  loadSnapshot(tracks: RenderedTrack[]): void {
    this.allTracks = tracks;
    this.renderer.loadSnapshot(tracks, this.vp, this.selectedId);
  }

  applyDelta(updated: RenderedTrack[], lost: number[]): void {
    // Update local store
    const map = new Map(this.allTracks.map(t => [t.id, t]));
    updated.forEach(t => map.set(t.id, t));
    lost.forEach(id => map.delete(id));
    this.allTracks = Array.from(map.values());
    this.renderer.applyDelta(updated, lost, this.vp, this.selectedId);
  }

  setSelected(id: number | null): void {
    this.selectedId = id;
    this.renderer.loadSnapshot(this.allTracks, this.vp, id);
  }

  // ─── rAF loop ─────────────────────────────────────────────────────────────

  private startLoop(): void {
    const loop = (ts: number) => {
      this.renderer.draw(ts);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);

    // Pause when hidden to save GPU
    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(this.rafId);
      } else {
        this.rafId = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', onVis);
  }

  // ─── Pan + zoom ───────────────────────────────────────────────────────────

  private attachPointerEvents(el: HTMLElement): void {
    el.addEventListener('pointerdown', e => {
      this.isDragging = true;
      this.dragOrigin = { x: e.clientX, y: e.clientY, ...this.vp };
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', e => {
      if (!this.isDragging) return;
      const W       = this.wc.canvas.width  / (window.devicePixelRatio ?? 1);
      const H       = this.wc.canvas.height / (window.devicePixelRatio ?? 1);
      const d       = this.dragOrigin;
      const dLon    = -((e.clientX - d.x) / W) * (d.maxLon - d.minLon);
      const dLat    =  ((e.clientY - d.y) / H) * (d.maxLat - d.minLat);
      this.vp = { minLat: d.minLat+dLat, maxLat: d.maxLat+dLat,
                  minLon: d.minLon+dLon, maxLon: d.maxLon+dLon };
      this.renderer.reproject(this.allTracks, this.vp, this.selectedId);
      this.onViewport?.(this.vp);
    });

    el.addEventListener('pointerup',     () => { this.isDragging = false; });
    el.addEventListener('pointercancel', () => { this.isDragging = false; });

    el.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 0.87;
      const cLat   = (this.vp.minLat + this.vp.maxLat) / 2;
      const cLon   = (this.vp.minLon + this.vp.maxLon) / 2;
      const latH   = ((this.vp.maxLat - this.vp.minLat) / 2) * factor;
      const lonH   = ((this.vp.maxLon - this.vp.minLon) / 2) * factor;
      this.vp = { minLat: cLat-latH, maxLat: cLat+latH,
                  minLon: cLon-lonH, maxLon: cLon+lonH };
      this.renderer.reproject(this.allTracks, this.vp, this.selectedId);
      this.onViewport?.(this.vp);
    }, { passive: false });

    // Click hit-test: find nearest track in NDC space
    el.addEventListener('click', e => {
      if (this.isDragging) return;
      const rect = el.getBoundingClientRect();
      const dpr  = window.devicePixelRatio ?? 1;
      const mx   = ((e.clientX - rect.left) / rect.width)  *  2 - 1;
      const my   = ((e.clientY - rect.top)  / rect.height) * -2 + 1;

      let nearest: RenderedTrack | null = null;
      let minDist = 0.04;

      for (const t of this.allTracks) {
        const ndc  = project(t.lat, t.lon, this.vp);
        const dist = Math.hypot(ndc.x - mx, ndc.y - my);
        if (dist < minDist) { minDist = dist; nearest = t; }
      }

      const id = nearest?.id ?? null;
      this.selectedId = id;
      this.renderer.loadSnapshot(this.allTracks, this.vp, id);
      this.onSelect?.(id);
    });
  }

  getViewport(): Viewport { return { ...this.vp }; }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.wc.destroy();
    this.overlay.remove();
  }
}
