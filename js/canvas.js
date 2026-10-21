/*
 * js/canvas.js
 *
 * CANVAS ENGINE for the swarm-vault dashboard rebuild.
 *
 * Owns a full-viewport <canvas id="grid"> that draws an infinite 2D plane:
 * a subtle dot grid with parallax layers plus a soft radial vignette.
 *
 * Public API (used by sibling workers, keep stable):
 *
 *   class Camera
 *     state { x, y, k }  (world coords at the screen origin, plus scale)
 *     worldToScreen(wx, wy) -> { x, y } in CSS px
 *     screenToWorld(sx, sy) -> { x, y } in world units
 *     panBy(dx, dy)  pan by a screen-space delta (CSS px)
 *     zoomAt(sx, sy, factor)  zoom around a screen point, factor is a ratio
 *     flyTo(wx, wy, targetK, durationMs)  animate so the world point lands
 *       at the center of the viewport, with easeInOutCubic over
 *       requestAnimationFrame. Any pointer input cancels it.
 *     cancelAnim()  stop a running flyTo
 *     onCameraChange(cb) -> unsubscribe fn. Called on every state change.
 *     setViewport(w, h)  tell the camera the viewport size (CSS px).
 *       Used by flyTo for centering and by mountGrid on resize.
 *     destroy()  remove listeners and stop the render loop.
 *     k is clamped to [0.15, 3].
 *
 *   function drawGrid(ctx, camera, W, H, theme)
 *     Paint the infinite dot grid + vignette. ctx must already be set up
 *     for CSS-pixel drawing (DPR transform applied by the caller).
 *     theme: { bg, dot, dotFar, dotMajor, vignetteEdge, vignetteCenter }.
 *     All theme keys optional; defaults match the Moto monochrome theme.
 *
 *   function mountGrid(canvas)
 *     Size the canvas for the device pixel ratio, start the render loop,
 *     attach drag-pan (with inertia), wheel-zoom (trackpad normalized),
 *     and reduced-motion handling. Returns the Camera.
 *
 * Coordinate note: worldToScreen assumes the world layer (#world-layer)
 * is positioned at the same origin as the canvas (top-left of viewport).
 * folders.js positions folder cards with worldToScreen, so this must hold.
 *
 * No em-dashes in comments.
 */

const K_MIN = 0.15;
const K_MAX = 3.0;

function clampK(k) {
  if (!Number.isFinite(k)) return 1;
  return Math.min(K_MAX, Math.max(K_MIN, k));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function reducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* ------------------------------------------------------------------ */
/* Camera                                                             */
/* ------------------------------------------------------------------ */

export class Camera {
  constructor(opts = {}) {
    this.x = typeof opts.x === "number" ? opts.x : 0;
    this.y = typeof opts.y === "number" ? opts.y : 0;
    this.k = clampK(typeof opts.k === "number" ? opts.k : 1);
    this._vw = 0; /* viewport width in CSS px */
    this._vh = 0; /* viewport height in CSS px */
    this._listeners = new Set();
    this._animId = null; /* running flyTo rAF id */
    this._reduced = reducedMotion();
    this.destroy = null; /* set by mountGrid */
  }

  setViewport(w, h) {
    this._vw = Math.max(0, w || 0);
    this._vh = Math.max(0, h || 0);
  }

  worldToScreen(wx, wy) {
    return { x: (wx - this.x) * this.k, y: (wy - this.y) * this.k };
  }

  screenToWorld(sx, sy) {
    return { x: sx / this.k + this.x, y: sy / this.k + this.y };
  }

  panBy(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.cancelAnim();
    this.x -= dx / this.k;
    this.y -= dy / this.k;
    this._emit();
  }

  zoomAt(sx, sy, factor) {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    this.cancelAnim();
    /* World point under the cursor before the zoom. */
    const bx = sx / this.k + this.x;
    const by = sy / this.k + this.y;
    const nk = clampK(this.k * factor);
    /* Re-anchor so that same world point stays under the cursor. */
    this.k = nk;
    this.x = bx - sx / nk;
    this.y = by - sy / nk;
    this._emit();
  }

  flyTo(wx, wy, targetK, durationMs = 600) {
    this.cancelAnim();
    const tk = clampK(targetK);
    /* Target top-left such that (wx, wy) lands at the viewport center. */
    const tx = this._vw > 0 ? wx - this._vw / 2 / tk : wx;
    const ty = this._vh > 0 ? wy - this._vh / 2 / tk : wy;
    if (this._reduced || !(durationMs > 0)) {
      this.x = tx;
      this.y = ty;
      this.k = tk;
      this._emit();
      return;
    }
    const sx = this.x;
    const sy = this.y;
    const sk = this.k;
    const t0 = performance.now();
    const dur = Math.max(1, durationMs);
    const step = (now) => {
      this._animId = null;
      const t = Math.min(1, (now - t0) / dur);
      const e = easeInOutCubic(t);
      this.x = sx + (tx - sx) * e;
      this.y = sy + (ty - sy) * e;
      this.k = sk + (tk - sk) * e;
      this._emit();
      if (t < 1) this._animId = requestAnimationFrame(step);
    };
    this._animId = requestAnimationFrame(step);
  }

  cancelAnim() {
    if (this._animId !== null) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
  }

  onCameraChange(cb) {
    if (typeof cb !== "function") return () => {};
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  _emit() {
    for (const cb of this._listeners) {
      try {
        cb(this);
      } catch (err) {
        /* One bad listener must not break the camera or other listeners. */
        if (typeof console !== "undefined") console.error(err);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Grid painting                                                      */
/* ------------------------------------------------------------------ */

/* Moto monochrome theme, matches style.css variables. */
const DEFAULT_THEME = {
  bg: "#080807",
  dot: "rgba(236, 233, 223, 0.075)", /* near layer, bone dots */
  dotFar: "rgba(236, 233, 223, 0.045)", /* far layer, dimmer */
  dotMajor: "rgba(201, 247, 58, 0.10)", /* acid accent, every 5th line */
  vignetteCenter: "rgba(0, 0, 0, 0)",
  vignetteEdge: "rgba(0, 0, 0, 0.5)",
};

function mod(n, m) {
  return ((n % m) + m) % m;
}

/*
 * Draw one dot layer anchored to world coordinates. `spacingWorld` is the
 * dot pitch in world units, `depth` is the parallax factor: 1 moves with
 * the world exactly, < 1 drifts slower so the layer reads as farther away.
 */
function drawDotLayer(ctx, camera, W, H, spacingWorld, depth, color, radius) {
  const spacingPx = spacingWorld * camera.k;
  if (spacingPx < 9) return; /* too dense to read, skip instead of smearing */
  if (spacingPx > Math.max(W, H) * 2) return; /* nothing visible */
  const k = camera.k * depth;
  const ox = mod(camera.x * k, spacingPx);
  const oy = mod(camera.y * k, spacingPx);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let y = -oy; y <= H + spacingPx; y += spacingPx) {
    for (let x = -ox; x <= W + spacingPx; x += spacingPx) {
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}

export function drawGrid(ctx, camera, W, H, theme = {}) {
  if (!ctx || !camera || !(W > 0) || !(H > 0)) return;
  const t = Object.assign({}, DEFAULT_THEME, theme);

  /* Background fill. */
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);

  /*
   * Two parallax dot layers. The far layer is pitched 3x wider and drifts
   * at 0.5 depth; the near layer is the readable reference grid and every
   * 5th dot is tinted with the acid accent for orientation.
   */
  const NEAR = 44;
  const majorSpacingPx = NEAR * 5 * camera.k;
  drawDotLayer(ctx, camera, W, H, NEAR * 3, 0.5, t.dotFar, 1.1);
  drawDotLayer(ctx, camera, W, H, NEAR, 1, t.dot, 1.3);
  if (majorSpacingPx >= 9 && majorSpacingPx <= Math.max(W, H) * 2) {
    drawDotLayer(ctx, camera, W, H, NEAR * 5, 1, t.dotMajor, 1.6);
  }

  /* Soft radial vignette, darkest at the corners. */
  const cx = W / 2;
  const cy = H / 2;
  const r = Math.hypot(cx, cy);
  const grad = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
  grad.addColorStop(0, t.vignetteCenter);
  grad.addColorStop(1, t.vignetteEdge);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

/* ------------------------------------------------------------------ */
/* mountGrid                                                          */
/* ------------------------------------------------------------------ */

export function mountGrid(canvas) {
  if (!canvas) throw new Error("mountGrid requires a <canvas> element");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("mountGrid: 2d context unavailable");

  const camera = new Camera();
  const reduced = reducedMotion();
  let W = 0;
  let H = 0;
  let rafId = 0;
  let inertiaId = null;
  let disposed = false;

  /* ---- sizing: DPR aware, canvas is full viewport ---- */
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    W = Math.max(0, rect.width);
    H = Math.max(0, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    camera.setViewport(W, H);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  /* ---- continuous render loop ---- */
  const render = () => {
    rafId = 0;
    if (disposed) return;
    drawGrid(ctx, camera, W, H);
    rafId = requestAnimationFrame(render);
  };
  rafId = requestAnimationFrame(render);

  /* ---- drag to pan with inertia ---- */
  canvas.style.touchAction = "none";
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let samples = []; /* [{ t, x, y }] for velocity estimation */

  const cancelInertia = () => {
    if (inertiaId !== null) {
      cancelAnimationFrame(inertiaId);
      inertiaId = null;
    }
  };

  const userInterrupt = () => {
    camera.cancelAnim();
    cancelInertia();
  };

  function startInertia(vx, vy) {
    cancelInertia();
    if (reduced) return;
    let last = performance.now();
    const step = (now) => {
      inertiaId = null;
      if (disposed) return;
      const dt = Math.min(50, Math.max(0, now - last));
      last = now;
      /* Frame-rate independent exponential decay. */
      const decay = Math.pow(0.94, dt / 16.7);
      vx *= decay;
      vy *= decay;
      camera.panBy(vx * dt, vy * dt);
      /* panBy cancels the flyTo anim but that is already stopped. */
      if (Math.hypot(vx, vy) > 0.015) {
        inertiaId = requestAnimationFrame(step);
      }
    };
    inertiaId = requestAnimationFrame(step);
  }

  const onPointerDown = (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    userInterrupt();
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    samples = [{ t: performance.now(), x: lastX, y: lastY }];
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {
      /* Pointer capture not supported or already released. */
    }
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    camera.panBy(dx, dy);
    const now = performance.now();
    samples.push({ t: now, x: lastX, y: lastY });
    /* Keep only the last ~120ms of samples for velocity. */
    while (samples.length > 2 && now - samples[0].t > 120) samples.shift();
  };

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      if (e && e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    } catch (_) {
      /* Ignore. */
    }
    if (reduced || samples.length < 2) return;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return;
    const vx = (last.x - first.x) / dt; /* screen px per ms */
    const vy = (last.y - first.y) / dt;
    const speed = Math.hypot(vx, vy);
    /* Only fling if there is real motion: > ~60 px/s. */
    if (speed > 0.06) startInertia(vx, vy);
  };

  /* ---- wheel to zoom around the cursor, trackpad normalized ---- */
  const onWheel = (e) => {
    e.preventDefault();
    userInterrupt();
    /* deltaMode 1 = lines, 2 = pages. Normalize to device px. */
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 16 * 3;
    /* Pinch-to-zoom sends ctrlKey wheel events with small deltas. */
    const sensitivity = e.ctrlKey ? 0.01 : 0.0018;
    const factor = Math.exp(-dy * sensitivity);
    const rect = canvas.getBoundingClientRect();
    camera.zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  camera.destroy = () => {
    if (disposed) return;
    disposed = true;
    userInterrupt();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    ro.disconnect();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", endDrag);
    canvas.removeEventListener("pointercancel", endDrag);
    canvas.removeEventListener("wheel", onWheel);
    camera._listeners.clear();
  };

  return camera;
}
