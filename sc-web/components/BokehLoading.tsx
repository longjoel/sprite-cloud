"use client";

import { useEffect, useRef, useState } from "react";
import type { StepState } from "./GamePlayerPipeline";

// ── Bokeh particle canvas ──────────────────────────────────────────────
//
// Renders a field of glowing circular particles (bokeh / circles of confusion)
// that drift, pulse, and bloom as real pipeline stages complete.
//
// When the user prefers reduced motion, the canvas is replaced with a static
// gradient that still communicates connection progress without continuous
// animation.
//
// Props:
//   pipeline  — current step states from GamePlayer
//   resolving — true while the page is still resolving the short code
//   fadeOut   — true when the overlay is fading out

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
  hue: number;
  opacity: number;
  spawnedAt: number;
}

const HUES = [195, 200, 205, 210, 190]; // sky blue → cyan → cool blue
const MAX_PARTICLES = 120;
const BASELINE_PARTICLES = 30;
const BURST_PER_STEP = 18;

const STEP_IDS = ["rtc", "core", "stream", "playing"];

interface BokehLoadingProps {
  pipeline?: Record<string, StepState>;
  resolving?: boolean;
  fadeOut?: boolean;
  width?: number | string;
  height?: number | string;
}

export default function BokehLoading({
  pipeline = {},
  resolving = false,
  fadeOut = false,
  width = "100%",
  height = "100%",
}: BokehLoadingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const frameRef = useRef(0);
  const prevDoneRef = useRef(0);
  const fadeRef = useRef(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  // Detect reduced-motion preference
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Count how many steps are "done"
  const doneCount = STEP_IDS.reduce(
    (n, id) => n + (pipeline[id] === "done" ? 1 : 0),
    resolving ? 0 : 0,
  );
  const totalSteps = STEP_IDS.length;
  const progress = doneCount / totalSteps;

  // ── Spawn particle ──────────────────────────────────────────────────
  const spawnParticle = (stepIndex: number): Particle => ({
    x: 0.1 + Math.random() * 0.8,
    y: 0.1 + Math.random() * 0.8,
    vx: (Math.random() - 0.5) * 0.0003,
    vy: (Math.random() - 0.5) * 0.0003,
    r: 3 + Math.random() * 22,
    phase: Math.random() * Math.PI * 2,
    hue: HUES[Math.floor(Math.random() * HUES.length)],
    opacity: 0,
    spawnedAt: stepIndex,
  });

  // ── Burst spawn on step completion ──────────────────────────────────
  useEffect(() => {
    if (reducedMotion) return;
    const particles = particlesRef.current;
    if (doneCount > prevDoneRef.current && particles.length < MAX_PARTICLES) {
      for (let i = 0; i < BURST_PER_STEP; i++) {
        particles.push(spawnParticle(doneCount));
      }
    }
    while (particles.length < BASELINE_PARTICLES) {
      particles.push(spawnParticle(0));
    }
    prevDoneRef.current = doneCount;
  }, [doneCount, reducedMotion]);

  // ── Animation loop (skipped when reduced motion) ────────────────────
  useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf: number;
    let mouseX = 0.5;
    let mouseY = 0.5;

    const onMove = (e: MouseEvent) => {
      mouseX = e.clientX / window.innerWidth;
      mouseY = e.clientY / window.innerHeight;
    };
    window.addEventListener("mousemove", onMove, { passive: true });

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const tick = () => {
      frameRef.current++;
      const t = frameRef.current;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const particles = particlesRef.current;

      const targetFade = fadeOut ? 0 : 1;
      fadeRef.current += (targetFade - fadeRef.current) * 0.04;

      ctx.clearRect(0, 0, w, h);

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        const parallax = p.r * 0.008;
        p.x += p.vx + (mouseX - 0.5) * 0.0002 * parallax;
        p.y += p.vy + (mouseY - 0.5) * 0.0002 * parallax;

        if (p.x < -0.05) p.x = 1.05;
        if (p.x > 1.05) p.x = -0.05;
        if (p.y < -0.05) p.y = 1.05;
        if (p.y > 1.05) p.y = -0.05;

        const baseOpacity = 0.08 + progress * 0.25;
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.02 + p.phase);
        const targetOp = baseOpacity * pulse * (0.9 + Math.random() * 0.1);
        p.opacity += (targetOp - p.opacity) * 0.03;

        const alpha = p.opacity * fadeRef.current;
        if (alpha < 0.003 && fadeOut) {
          particles.splice(i, 1);
          continue;
        }

        const px = p.x * w;
        const py = p.y * h;
        const radius = p.r * (0.8 + 0.2 * Math.sin(t * 0.015 + p.phase));

        if (radius < 1) continue;

        for (let pass = 0; pass < 3; pass++) {
          const scale = 1 + pass * 1.8;
          const a = alpha * (3 - pass) * 0.18;
          const r = radius * scale;

          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);

          const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
          grad.addColorStop(0, `hsla(${p.hue}, 60%, 70%, ${a})`);
          grad.addColorStop(0.4, `hsla(${p.hue}, 50%, 55%, ${a * 0.5})`);
          grad.addColorStop(1, `hsla(${p.hue}, 40%, 40%, 0)`);
          ctx.fillStyle = grad;
          ctx.fill();
        }
      }

      const activeCount = particles.length;
      const floorTarget = fadeOut ? 0 : BASELINE_PARTICLES;
      if (activeCount < floorTarget) {
        for (let i = 0; i < floorTarget - activeCount; i++) {
          particles.push(spawnParticle(doneCount));
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("resize", resize);
    };
  }, [progress, fadeOut, doneCount, reducedMotion]);

  // Static gradient for reduced-motion users
  const containerStyle: React.CSSProperties = {
    width: typeof width === "number" ? `${width}px` : width,
    height: typeof height === "number" ? `${height}px` : height,
    display: "block",
    background: `radial-gradient(
      ellipse at 50% ${40 + progress * 10}%,
      rgba(56, 189, 248, ${0.06 + progress * 0.08}) 0%,
      rgba(14, 165, 233, ${0.03 + progress * 0.04}) 40%,
      transparent 70%
    )`,
    transition: "background 0.8s ease",
  };

  if (reducedMotion) {
    return <div style={containerStyle} />;
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: typeof width === "number" ? `${width}px` : width,
        height: typeof height === "number" ? `${height}px` : height,
        display: "block",
        filter: "blur(0.4px)",
      }}
    />
  );
}
