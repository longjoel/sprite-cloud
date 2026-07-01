"use client";

import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export default function Input({ label, style, ...rest }: InputProps) {
  return (
    <div style={{ marginBottom: "var(--space-5)" }}>
      {label && (
        <label
          style={{
            display: "block",
            fontSize: "var(--font-size-sm)",
            fontFamily: "var(--font-mono)",
            color: "var(--color-text-secondary)",
            marginBottom: "var(--space-2)",
          }}
        >
          {label}
        </label>
      )}
      <input
        style={{
          width: "100%",
          padding: "var(--space-3) var(--space-4)",
          background: "var(--color-bg-deep)",
          border: "1px solid var(--color-border-default)",
          borderRadius: "2px",
          color: "var(--color-text-primary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--font-size-base)",
          outline: "none",
          ...style,
        }}
        {...rest}
      />
    </div>
  );
}
