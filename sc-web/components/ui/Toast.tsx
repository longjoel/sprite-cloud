"use client";

import { useEffect, useState } from "react";

interface ToastProps {
  /** Duration in ms before auto-dismiss. 0 = persistent. */
  duration?: number;
  /** Fire this after dismiss (for parent to clear state). */
  onDone?: () => void;
  variant?: "success" | "error";
  children: React.ReactNode;
}

export default function Toast({
  duration = 2000,
  onDone,
  variant = "success",
  children,
}: ToastProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (duration <= 0) return;
    const t = setTimeout(() => {
      setVisible(false);
      onDone?.();
    }, duration);
    return () => clearTimeout(t);
  }, [duration, onDone]);

  if (!visible) return null;

  const borderColor =
    variant === "success" ? "var(--color-success)" : "var(--color-error)";

  return (
    <div
      style={{
        position: "absolute",
        top: "var(--space-9)",
        left: "50%",
        transform: "translateX(-50%)",
        background: "var(--color-mahogany)",
        border: `1px solid ${borderColor}`,
        borderRadius: "var(--radius-md)",
        padding: "var(--space-4) var(--space-7)",
        fontSize: "var(--font-size-base)",
        fontFamily: "var(--font-mono)",
        color: "var(--color-cream)",
        zIndex: 100,
      }}
    >
      {children}
    </div>
  );
}
