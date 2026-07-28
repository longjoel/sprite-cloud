"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AppBar, Toolbar, Typography, Button, IconButton, Drawer,
  List, ListItem, ListItemButton, ListItemText, Box, useMediaQuery, useTheme,
} from "@mui/material";
import { Menu as MenuIcon } from "@mui/icons-material";

// ── AppHeader — MUI AppBar with responsive hamburger drawer ─────────

interface AppHeaderLink {
  label: string;
  href: string;
}

interface AppHeaderProps {
  userName?: string | null;
  links?: AppHeaderLink[];
}

export default function AppHeader({ userName, links = [] }: AppHeaderProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const theme = useTheme();
  const isNarrow = useMediaQuery(theme.breakpoints.down("sm"));

  return (
    <>
      <AppBar
        position="sticky"
        sx={{
          background: "var(--color-sky-mid)",
          borderBottom: "2px solid var(--color-accent)",
          boxShadow: "none",
        }}
      >
        <Toolbar sx={{ gap: 1 }}>
          {/* Hamburger — narrow only */}
          {isNarrow && (
            <IconButton
              edge="start"
              color="inherit"
              aria-label="Open navigation"
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon />
            </IconButton>
          )}

          {/* Logo */}
          <Typography
            component={Link}
            href="/"
            variant="h6"
            sx={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-accent)",
              textDecoration: "none",
              fontWeight: 700,
              letterSpacing: "0.02em",
              textTransform: "uppercase",
              fontSize: "var(--font-size-lg)",
              flexGrow: isNarrow ? 1 : 0,
            }}
          >
            Sprite Cloud
          </Typography>

          {/* Desktop links */}
          {!isNarrow && (
            <Box sx={{ display: "flex", gap: 1, ml: 2, flexGrow: 1 }}>
              {links.map((link) => (
                <Button
                  key={link.href}
                  component={Link}
                  href={link.href}
                  sx={{
                    color: "var(--color-accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--font-size-sm)",
                    textTransform: "none",
                  }}
                >
                  {link.label}
                </Button>
              ))}
            </Box>
          )}

          {/* User name — hidden at narrow widths */}
          {!isNarrow && userName && (
            <Typography
              variant="body2"
              sx={{ color: "var(--color-cloud-dim)", mr: 1, fontFamily: "var(--font-mono)" }}
            >
              {userName}
            </Typography>
          )}
        </Toolbar>
      </AppBar>

      {/* Narrow drawer */}
      <Drawer
        anchor="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        slotProps={{ paper: { sx: { background: "var(--color-sky-mid)", color: "var(--color-cloud)", minWidth: 220 } } }}
      >
        <Box sx={{ p: 2, borderBottom: "1px solid var(--color-border-default)" }}>
          <Typography sx={{ fontFamily: "var(--font-mono)", color: "var(--color-accent)", fontWeight: 700 }}>
            Sprite Cloud
          </Typography>
          {userName && (
            <Typography variant="body2" sx={{ color: "var(--color-cloud-dim)", mt: 0.5, fontFamily: "var(--font-mono)" }}>
              {userName}
            </Typography>
          )}
        </Box>
        <List>
          {links.map((link) => (
            <ListItem key={link.href} disablePadding>
              <ListItemButton
                component={Link}
                href={link.href}
                onClick={() => setDrawerOpen(false)}
              >
                <ListItemText
                  primary={link.label}
                  slotProps={{ primary: { sx: { fontFamily: "var(--font-mono)", fontSize: "var(--font-size-sm)", color: "var(--color-accent)" } } }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Drawer>
    </>
  );
}
