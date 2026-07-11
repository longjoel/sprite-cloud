"use client";

import { useEffect, useRef, useState } from "react";
import { LIBRARY_SECTIONS, type LibrarySection } from "@/lib/ui/library-view-model";
import styles from "./LibraryToolbar.module.css";

type ViewMode = "grid" | "table";

interface LibraryToolbarProps {
  activeSection: LibrarySection;
  counts: Record<LibrarySection, number>;
  search: string;
  platforms: string[];
  platformCounts: Record<string, number>;
  selectedPlatforms: ReadonlySet<string>;
  viewMode: ViewMode;
  onSectionChange: (section: LibrarySection) => void;
  onSearchChange: (value: string) => void;
  onPlatformToggle: (platform: string) => void;
  onClearPlatforms: () => void;
  onViewModeChange: (view: ViewMode) => void;
}

export default function LibraryToolbar({
  activeSection, counts, search, platforms, platformCounts, selectedPlatforms, viewMode,
  onSectionChange, onSearchChange, onPlatformToggle, onClearPlatforms, onViewModeChange,
}: LibraryToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        filterButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <div className={styles.toolbar} aria-label="Library controls">
      <nav className={styles.tabs} aria-label="Library sections">
        {LIBRARY_SECTIONS.map(({ id, label }) => (
          <button key={id} type="button" aria-pressed={activeSection === id}
            className={styles.tab} onClick={() => onSectionChange(id)}>
            {label} ({counts[id]})
          </button>
        ))}
      </nav>

      <div className={styles.commands}>
        <input className={styles.search} type="search" aria-label="Search games"
          placeholder="Search games..." value={search} onChange={(event) => onSearchChange(event.target.value)} />

        <div className={styles.filter} ref={filterRef}>
          <button ref={filterButtonRef} type="button" className={styles.systemButton} data-active={selectedPlatforms.size > 0}
            aria-label="Filter by system" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="library-system-menu"
            onClick={() => setMenuOpen((open) => !open)}>
            <span className={styles.longLabel}>{selectedPlatforms.size ? `Systems (${selectedPlatforms.size})` : "All Systems"}</span>
            <span aria-hidden="true"> {menuOpen ? "▲" : "▼"}</span>
          </button>
          {menuOpen && (
            <div id="library-system-menu" className={styles.menu} role="menu" aria-label="Systems">
              <button type="button" className={styles.option} onClick={() => { onClearPlatforms(); setMenuOpen(false); }}>
                All Systems <span className={styles.optionCount}>({counts.all})</span>
              </button>
              {platforms.map((platform) => (
                <label className={styles.option} key={platform}>
                  <input type="checkbox" checked={selectedPlatforms.has(platform)} onChange={() => onPlatformToggle(platform)} />
                  {platform}<span className={styles.optionCount}>({platformCounts[platform] || 0})</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className={styles.views} aria-label="Library view">
          <button type="button" className={styles.control} aria-label="Grid view" aria-pressed={viewMode === "grid"}
            onClick={() => onViewModeChange("grid")}>▦<span className={styles.longLabel}> Grid</span></button>
          <button type="button" className={styles.control} aria-label="Table view" aria-pressed={viewMode === "table"}
            onClick={() => onViewModeChange("table")}>☰<span className={styles.longLabel}> Table</span></button>
        </div>

        {selectedPlatforms.size > 0 && (
          <div className={styles.chips} aria-label="Active platform filters">
            {[...selectedPlatforms].map((platform) => (
              <button type="button" className={styles.chip} key={platform} aria-label={`Remove ${platform} filter`}
                onClick={() => onPlatformToggle(platform)}>{platform} ×</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
