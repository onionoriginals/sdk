import { useEffect, useRef } from 'react';

/**
 * The hero's eclipse: a dark disc, a white limb and an amber "diamond" at
 * second contact, the logo drawn as a scene. Purely decorative (aria-hidden);
 * the hero's words carry the meaning.
 *
 * Intro: the limb draws itself round to 1:30 and the diamond blooms there.
 * Loop: corona streaks drift outward; the diamond breathes. The pointer pulls
 * the diamond a few degrees round the limb. Reduced motion draws the resting
 * frame once. Paused off-screen and in hidden tabs.
 */

const STREAKS = 1100;
const REST_ANGLE = -Math.PI / 4.2;
const PULL = 0.07; // radians, about 4 degrees

type Streak = { a: number; d: number; v: number; w: number };

function seed(s: Streak, spread = false): Streak {
  s.a = Math.random() * Math.PI * 2;
  s.d = 1 + Math.random() * (spread ? 0.75 : 0.03);
  s.v = 0.0005 + Math.random() * 0.0013;
  s.w = 0.5 + Math.random() * 1.1;
  return s;
}

export function Eclipse({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const streaks = Array.from({ length: STREAKS }, () => seed({} as Streak, true));
    let W = 0, H = 0, R = 0, cx = 0, cy = 0;
    let raf = 0, running = false, visible = true;
    let start = performance.now();
    let pull = 0, target = 0;

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      W = rect.width; H = rect.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The corona fades to nothing by about 1.8R; keep it inside the canvas so no edge shows.
      R = Math.min(W / 2, H / 2) / 1.8;
      cx = W / 2; cy = H / 2;
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, W, H);
      pull += (target - pull) * 0.06;
      const sa = REST_ANGLE + pull;

      ctx.globalCompositeOperation = 'lighter';
      for (const s of streaks) {
        if (!reduce) { s.d += s.v; if (s.d > 1.78) seed(s); }
        const k = (s.d - 1) / 0.78;
        const near = Math.cos(s.a - sa) * 0.5 + 0.5;
        const alpha = Math.max(0, 1 - k) * (0.07 + near * 0.24);
        const r1 = R * s.d, r2 = R * (s.d + 0.05 + near * 0.05);
        ctx.strokeStyle = `rgba(255,${(150 + near * 60) | 0},${(60 + near * 40) | 0},${alpha})`;
        ctx.lineWidth = s.w;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(s.a) * r1, cy + Math.sin(s.a) * r1);
        ctx.lineTo(cx + Math.cos(s.a) * r2, cy + Math.sin(s.a) * r2);
        ctx.stroke();
      }
      const halo = ctx.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.78);
      halo.addColorStop(0, 'rgba(255,150,50,.26)');
      halo.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.78, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

      // The moon.
      ctx.fillStyle = '#07080b';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

      // The limb, drawn on during the intro.
      const intro = Math.min(1, t / 1800);
      const drawn = 1 - Math.pow(1 - intro, 3);
      ctx.strokeStyle = '#f6f3ec';
      ctx.lineWidth = Math.max(2.5, R * 0.028);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(cx, cy, R, sa - Math.PI * 2 * drawn, sa); ctx.stroke();

      // The diamond.
      const bloom = Math.max(0, Math.min(1, (t - 1500) / 700));
      if (bloom > 0) {
        const eased = 1 - Math.pow(1 - bloom, 3);
        const breathe = 1 + Math.sin(t / 1300) * 0.06;
        const sx = cx + Math.cos(sa) * R, sy = cy + Math.sin(sa) * R;
        const L = R * 0.62 * eased * breathe, waist = R * 0.022;
        ctx.globalCompositeOperation = 'lighter';
        const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 0.5);
        glow.addColorStop(0, `rgba(255,190,110,${0.75 * eased})`);
        glow.addColorStop(0.4, `rgba(255,140,40,${0.3 * eased})`);
        glow.addColorStop(1, 'rgba(255,120,30,0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(sx, sy, R * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${eased})`;
        for (const [dx, dy, l] of [[1, 0, L], [-1, 0, L], [0, 1, L * 0.82], [0, -1, L * 0.82]]) {
          ctx.beginPath();
          ctx.moveTo(sx + dx * l, sy + dy * l);
          ctx.lineTo(sx + dy * waist, sy + dx * waist);
          ctx.lineTo(sx - dy * waist, sy - dx * waist);
          ctx.fill();
        }
        ctx.beginPath(); ctx.arc(sx, sy, R * 0.04 * eased, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
    };

    const loop = (now: number) => {
      draw(now - start);
      raf = requestAnimationFrame(loop);
    };
    const play = () => {
      if (reduce || running || !visible || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const pause = () => { running = false; cancelAnimationFrame(raf); };

    const resize = new ResizeObserver(() => { size(); if (reduce || !running) draw(reduce ? 4000 : performance.now() - start); });
    resize.observe(canvas);
    size();

    if (reduce) { draw(4000); return () => resize.disconnect(); }

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) play(); else pause();
    });
    io.observe(canvas);
    const onVisibility = () => (document.hidden ? pause() : play());
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      target = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth - 0.5) * 2)) * PULL;
    };
    const onLeave = () => { target = 0; };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    start = performance.now();
    play();
    return () => {
      pause();
      io.disconnect();
      resize.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
