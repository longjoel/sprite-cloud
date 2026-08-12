"use client";

import { useEffect, useState } from "react";

export function coverPosterUrl(url: string): string {
  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(url);
    const parsed = new URL(url, "https://sprite-cloud.invalid");
    if (!/^\/api\/covers\/[^/]+\/[^/]+\/?$/.test(parsed.pathname)) return url;
    parsed.searchParams.set("poster", "1");
    return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/**
 * Fail static during SSR/hydration, then enable animation only after the
 * browser positively reports that reduced motion is not requested.
 */
export function useMotionSafeCoverUrl(url?: string | null): string | null {
  const [motionAllowed, setMotionAllowed] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotionAllowed(!preference.matches);
    update();
    preference.addEventListener?.("change", update);
    return () => preference.removeEventListener?.("change", update);
  }, []);

  if (!url) return null;
  return motionAllowed ? url : coverPosterUrl(url);
}
