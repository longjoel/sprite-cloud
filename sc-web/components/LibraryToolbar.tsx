"use client";

import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Paper,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { LIBRARY_SECTIONS, type LibrarySection } from "@/lib/ui/library-view-model";

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
  activeSection,
  counts,
  search,
  platforms,
  platformCounts,
  selectedPlatforms,
  viewMode,
  onSectionChange,
  onSearchChange,
  onPlatformToggle,
  onClearPlatforms,
  onViewModeChange,
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
    <Box
      aria-label="Library controls"
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        mb: 3,
        p: 0.5,
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        flexWrap: "wrap",
      }}
    >
      <Box component="nav" aria-label="Library sections" sx={{ flexShrink: 0, overflowX: "auto" }}>
        <ToggleButtonGroup
          exclusive
          value={activeSection}
          onChange={(_, value: LibrarySection | null) => value && onSectionChange(value)}
          size="small"
        >
          {LIBRARY_SECTIONS.map(({ id, label }) => (
            <ToggleButton
              key={id}
              value={id}
              aria-pressed={activeSection === id}
              sx={{ whiteSpace: "nowrap", minHeight: 36, textTransform: "none" }}
            >
              {label} ({counts[id]})
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flex: "1 1 320px", minWidth: 0 }}>
        <TextField
          type="search"
          slotProps={{ input: { "aria-label": "Search games" } }}
          placeholder="Search games..."
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          size="small"
          sx={{ flex: "1 1 220px", minWidth: 140 }}
        />

        <Box ref={filterRef} sx={{ position: "relative", flexShrink: 0 }}>
          <Button
            ref={filterButtonRef}
            type="button"
            variant={selectedPlatforms.size > 0 ? "contained" : "outlined"}
            size="small"
            aria-label="Filter by platform"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls="library-system-menu"
            onClick={() => setMenuOpen((open) => !open)}
            sx={{ minHeight: 36, whiteSpace: "nowrap" }}
          >
            {selectedPlatforms.size ? `Platforms (${selectedPlatforms.size})` : "All Platforms"} {menuOpen ? "▲" : "▼"}
          </Button>
          {menuOpen && (
            <Paper
              id="library-system-menu"
              role="menu"
              aria-label="Systems"
              elevation={8}
              sx={{
                position: "absolute",
                right: 0,
                top: "calc(100% + 4px)",
                zIndex: 10,
                minWidth: 220,
                maxHeight: 360,
                overflowY: "auto",
                p: 0.5,
              }}
            >
              <Button
                type="button"
                fullWidth
                role="menuitem"
                onClick={() => { onClearPlatforms(); setMenuOpen(false); }}
                sx={{ justifyContent: "space-between", textTransform: "none" }}
              >
                All Platforms <Typography component="span" color="text.secondary">({counts.all})</Typography>
              </Button>
              {platforms.map((platform) => (
                <Box
                  component="label"
                  key={platform}
                  role="menuitemcheckbox"
                  aria-checked={selectedPlatforms.has(platform)}
                  sx={{ display: "flex", alignItems: "center", gap: 0.5, px: 1, minHeight: 40, cursor: "pointer" }}
                >
                  <Checkbox
                    size="small"
                    checked={selectedPlatforms.has(platform)}
                    onChange={() => onPlatformToggle(platform)}
                  />
                  <Typography component="span" sx={{ flex: 1 }}>{platform}</Typography>
                  <Typography component="span" color="text.secondary">({platformCounts[platform] || 0})</Typography>
                </Box>
              ))}
            </Paper>
          )}
        </Box>

        <ToggleButtonGroup
          aria-label="Library view"
          exclusive
          value={viewMode}
          onChange={(_, value: ViewMode | null) => value && onViewModeChange(value)}
          size="small"
          sx={{ flexShrink: 0 }}
        >
          <ToggleButton value="grid" aria-label="Grid view" aria-pressed={viewMode === "grid"} sx={{ minHeight: 36, textTransform: "none" }}>
            ▦ <Box component="span" sx={{ display: { xs: "none", sm: "inline" }, ml: 0.5 }}>Grid</Box>
          </ToggleButton>
          <ToggleButton value="table" aria-label="Table view" aria-pressed={viewMode === "table"} sx={{ minHeight: 36, textTransform: "none" }}>
            ☰ <Box component="span" sx={{ display: { xs: "none", sm: "inline" }, ml: 0.5 }}>Table</Box>
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {selectedPlatforms.size > 0 && (
        <Box aria-label="Active platform filters" sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
          {[...selectedPlatforms].map((platform) => (
            <Chip
              key={platform}
              label={platform}
              size="small"
              color="primary"
              onDelete={() => onPlatformToggle(platform)}
              deleteIcon={<Box component="span" aria-label={`Remove ${platform} filter`}>×</Box>}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
