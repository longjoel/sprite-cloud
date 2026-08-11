"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AppBar, Toolbar, Typography, Button, IconButton, Drawer,
  List, ListItem, ListItemButton, ListItemText, Box, useMediaQuery, useTheme,
} from "@mui/material";
import { Menu as MenuIcon } from "@mui/icons-material";
import { buildAppNavigationItems, isAppNavigationItemActive } from "@/lib/ui/app-navigation";

// ── AppHeader — shared route-aware navigation with responsive drawer ──

interface AppHeaderProps {
  userName?: string | null;
  authenticated?: boolean;
  isLanProxy?: boolean;
}

export default function AppHeader({ userName, authenticated = false, isLanProxy = false }: AppHeaderProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const links = buildAppNavigationItems({ authenticated, isLanProxy });
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

          {/* Brand */}
          <Box
            component={Link}
            href="/"
            aria-label="Sprite Cloud home"
            sx={{ display: "flex", alignItems: "center", flexGrow: isNarrow ? 1 : 0 }}
          >
            <Box
              component="img"
              src="/brand/sprite-cloud-logo-banner.jpg"
              alt="Sprite Cloud"
              width={150}
              height={50}
              sx={{
                display: "block",
                width: { xs: 112, sm: 150 },
                height: { xs: 38, sm: 50 },
                objectFit: "contain",
                borderRadius: 0.5,
              }}
            />
          </Box>

          {/* Desktop links */}
          {!isNarrow && (
            <Box sx={{ display: "flex", gap: 1, ml: 2, flexGrow: 1 }}>
              {links.map((link) => (
                <Button
                  key={link.href}
                  component={Link}
                  href={link.href}
                  aria-current={isAppNavigationItemActive(link.href, pathname) ? "page" : undefined}
                  sx={{
                    color: isAppNavigationItemActive(link.href, pathname) ? "primary.main" : "text.secondary",
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
          <Box
            component="img"
            src="/brand/sprite-cloud-logo-banner.jpg"
            alt="Sprite Cloud"
            width={150}
            height={50}
            sx={{ display: "block", width: 150, height: 50, objectFit: "contain", borderRadius: 0.5 }}
          />
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
                selected={isAppNavigationItemActive(link.href, pathname)}
                aria-current={isAppNavigationItemActive(link.href, pathname) ? "page" : undefined}
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
