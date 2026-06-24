import React from "react";

export default function MetadataRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <tr>
      <td style={S.metaLabel}>{label}</td>
      <td style={S.metaValue}>{value}</td>
    </tr>
  );
}

const S: Record<string, React.CSSProperties> = {
  metaLabel: {
    padding: "2px var(--space-6) 2px 0",
    color: "var(--color-muted)",
    textAlign: "right" as const,
    whiteSpace: "nowrap" as const,
  },
  metaValue: {
    padding: "2px 0",
    color: "var(--color-cream)",
    wordBreak: "break-all" as const,
  },
};
