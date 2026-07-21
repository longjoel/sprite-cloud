"use client";

interface CardProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export default function Card({ children, style }: CardProps) {
  return (
    <div
      style={{
        background: "var(--color-teak)",
        border: "1px solid var(--color-bamboo)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-6)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
