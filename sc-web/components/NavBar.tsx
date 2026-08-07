"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINK: React.CSSProperties = {
  color: "#94a3b8",
  textDecoration: "none",
  fontSize: 14,
  padding: "6px 12px",
  borderRadius: 6,
};

const NAV_ACTIVE: React.CSSProperties = {
  ...NAV_LINK,
  color: "#e2e8f0",
  background: "rgba(255,255,255,0.08)",
};

export default function NavBar() {
  const pathname = usePathname();

  const linkStyle = (href: string) =>
    pathname === href ? NAV_ACTIVE : NAV_LINK;

  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "8px 16px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(10,14,26,0.92)",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <Link href="/" style={{ fontWeight: 700, color: "#38bdf8", textDecoration: "none", marginRight: 24, fontSize: 16 }}>
        Sprite Cloud
      </Link>
      <Link href="/" style={linkStyle("/")}>Home</Link>
      <Link href="/library" style={linkStyle("/library")}>Library</Link>
    </nav>
  );
}
