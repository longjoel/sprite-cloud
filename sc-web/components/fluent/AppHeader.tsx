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
          backgroundColor: "background.paper",
          borderBottom: 1,
          borderColor: "divider",
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
              color: "primary.main",
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
                    color: "text.secondary",
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
              sx={{ color: "text.secondary", mr: 1 }}
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
        slotProps={{ paper: { sx: { minWidth: 220 } } }}
      >
        <Box sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}>
          <Typography sx={{ color: "primary.main", fontWeight: 700 }}>
            Sprite Cloud
          </Typography>
          {userName && (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
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
                  slotProps={{ primary: { sx: { color: "text.secondary" } } }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Drawer>
    </>
  );
}
