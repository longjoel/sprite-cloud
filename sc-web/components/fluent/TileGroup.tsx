"use client";

import type { ReactNode } from "react";

interface TileGroupProps {
  label: string;
  children: ReactNode;
}

export default function TileGroup({ label, children }: TileGroupProps) {
  return (
    <section className="tile-group">
      <h2 className="tile-group-header">{label}</h2>
      <div className="tile-group-grid">{children}</div>
    </section>
  );
}
