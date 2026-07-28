"use client";

import React from "react";

// ── Types ──────────────────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  type: "dir" | "file" | "error";
  children?: TreeNode[];
}

// ── Component ──────────────────────────────────────────────────────────

export default function TreeView({
  node,
  checked,
  onToggle,
  depth = 0,
}: {
  node: TreeNode;
  checked: Set<string>;
  onToggle: (path: string) => void;
  depth?: number;
}) {
  return (
    <div>
      <div
        style={{ ...S.treeRow, paddingLeft: depth * 16 + 8 }}
        onClick={() => node.type === "dir" && onToggle(node.name)}
      >
        {node.type === "dir" && (
          <span style={S.checkbox}>
            {checked.has(node.name) ? "☑" : "☐"}
          </span>
        )}
        <span style={S.treeIcon}>
          {node.type === "dir"
            ? "📁"
            : node.type === "error"
              ? "⚠"
              : "📄"}
        </span>
        <span
          style={{
            ...S.treeName,
            color:
              node.type === "error" ? "var(--color-error)" : undefined,
          }}
        >
          {node.name}
        </span>
      </div>
      {node.children?.map((child, i) => (
        <TreeView
          key={`${child.name}-${i}`}
          node={child}
          checked={checked}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  treeRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "3px 0",
    cursor: "pointer",
    fontSize: "var(--font-size-base)",
  },
  treeIcon: { fontSize: "var(--font-size-base)" },
  treeName: { fontSize: "var(--font-size-base)" },
  checkbox: {
    width: 16,
    fontSize: "var(--font-size-sm)",
    color: "var(--color-muted)",
  },
};
