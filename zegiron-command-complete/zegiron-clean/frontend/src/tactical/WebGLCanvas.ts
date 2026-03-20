/**
 * ZEGIRON Command — WebGL Canvas
 * frontend/src/tactical/WebGLCanvas.ts
 *
 * Manages the raw WebGL2 context. Not a React component — purely imperative
 * DOM. React only holds a ref to the container div; all canvas work is here.
 *
 * Handles:
 *  • Context creation with production settings
 *  • ResizeObserver — canvas pixel size tracks container
 *  • Shader compilation / program linking with detailed error messages
 *  • Global GL state (blend mode, clear colour)
 */

export interface GLContextOptions {
  antialias?:  boolean;
  clearColor?: [number, number, number, number];
}

export class WebGLCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly gl:     WebGL2RenderingContext;

  private resizeObs:      ResizeObserver;
  private resizeCallbacks: Array<(w: number, h: number) => void> = [];

  constructor(container: HTMLElement, opts: GLContextOptions = {}) {
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0',
      width: '100%', height: '100%',
      display: 'block', cursor: 'crosshair',
    });
    container.appendChild(this.canvas);

    const gl = this.canvas.getContext('webgl2', {
      antialias:           opts.antialias ?? false,  // SDF does its own AA
      premultipliedAlpha:  false,
      powerPreference:     'high-performance',
      desynchronized:      true,    // lower latency (hint only)
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    const [r, g, b, a] = opts.clearColor ?? [0.016, 0.035, 0.059, 1.0];
    gl.clearColor(r, g, b, a);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Set initial canvas size then watch for container resizes
    this.resizeObs = new ResizeObserver(entries => {
      for (const e of entries) {
        const dpr = window.devicePixelRatio ?? 1;
        const w   = Math.round(e.contentRect.width  * dpr);
        const h   = Math.round(e.contentRect.height * dpr);
        this.canvas.width  = w;
        this.canvas.height = h;
        this.resizeCallbacks.forEach(cb => cb(w, h));
      }
    });
    this.resizeObs.observe(container);

    // Trigger initial size
    const r2  = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio ?? 1;
    this.canvas.width  = Math.round(r2.width  * dpr);
    this.canvas.height = Math.round(r2.height * dpr);
  }

  onResize(cb: (w: number, h: number) => void): void {
    this.resizeCallbacks.push(cb);
  }

  destroy(): void {
    this.resizeObs.disconnect();
    this.canvas.remove();
  }

  // ── Shader utilities ─────────────────────────────────────────────────────
  compileShader(type: number, source: string): WebGLShader {
    const { gl } = this;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(s) ?? '';
      gl.deleteShader(s);
      const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      throw new Error(`[WebGL] ${kind} shader error:\n${info}`);
    }
    return s;
  }

  linkProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const { gl } = this;
    const vs   = this.compileShader(gl.VERTEX_SHADER,   vertSrc);
    const fs   = this.compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog) ?? '';
      gl.deleteProgram(prog);
      throw new Error(`[WebGL] Program link error:\n${info}`);
    }
    return prog;
  }
}
