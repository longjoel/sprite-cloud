# Design Philosophy: 1960s Neo-Futurism

**Status:** Proposed
**Date:** 2026-06-17

## Direction

Not "retro" as in pixelated 1980s games. **Retro-futurism** — the future
as imagined in 1964. The World's Fair, not the arcade.

Sprite Cloud should feel like a **physical object**. A piece of furniture.
A control panel. Not software that happens to be dark themed.

## Principles

1. **Warm, not cold.** Wood tones, brass, cream. No `#1a1a1a` gray.
2. **Hardware, not glass.** Buttons have weight. Surfaces have texture.
   Panels have trim. Nothing is weightless or translucent.
3. **Bright accents punch through.** Electric cyan, hot magenta, lime
   green — like neon against walnut. Used sparingly.
4. **Monospace where it counts.** Data, paths, code, timestamps.
   But UI labels can breathe with a geometric sans.
5. **Fake but intentional.** The wood grain is CSS, not a JPEG. The
   brass is a gradient. It knows it's a screen and leans in.

## References

- 1964 New York World's Fair pavilions
- Eames lounge chair (molded plywood + leather)
- Braun / Dieter Rams (but warmer)
- Forbidden Planet control room
- Fallout terminal screens (but less green, more cream)
- Wes Anderson color palettes (mustard, teal, coral)

## Color Palette

| Role | Name | Hex | Use |
|------|------|-----|-----|
| Deepest bg | Mahogany | `#1a1410` | Page background |
| Panel bg | Teak | `#2d2418` | Cards, surfaces |
| Raised bg | Walnut | `#3d3020` | Modals, elevated panels |
| Light bg | Bamboo | `#4a3a28` | Active states, hover |
| Trim | Brass | `#b8964a` | Borders, dividers, hardware |
| Text primary | Cream | `#e8dcc8` | Body text |
| Text muted | Faded brass | `#b8a888` | Secondary, labels |
| Accent cyan | Neon cyan | `#00e5ff` | Links, active, focus |
| Accent magenta | Hot magenta | `#ff3d7f` | Alerts, emphasis |
| Accent lime | Arcade green | `#a0ff40` | Play, go, success |
| Status ok | Emerald | `#4dff88` | Healthy, online, connected |
| Status warn | Amber | `#ffb830` | Degraded, relay, stale |
| Status error | Crimson | `#ff4d4d` | Offline, failed, dead |

## Typography

| Role | Font | Weight |
|------|------|--------|
| Headings | Geist Mono, 600 | Semi-bold |
| Body | Geist Sans, 400 | Regular |
| Code/Data | Geist Mono, 400 | Regular |
| UI Labels | Geist Sans, 500 | Medium |

All from Vercel's Geist family — geometric, engineered, zero nostalgia.
Ships as a variable font, no Google Fonts dependency.

## Components (conceptual)

- **Button:** Chunky, visible brass border. Slight inner shadow for depth.
  Active state lifts (like pressing a physical switch).
- **Card:** Dark teak with subtle brass top-border (like a control panel
  bezel). Optional texture overlay (CSS noise).
- **Input:** Dark walnut field with brass border. Focus → cyan glow.
- **Badge:** Brass pill with colored text. Like a label on a switchboard.
- **Modal:** Dark walnut panel with brass trim, slight grain texture.
  Backdrop is warm dark amber, not black.
- **Divider:** Single brass line, 1px, like metal trim between panels.

## Anti-patterns

- No pure black (`#000`) — too cold
- No pure white (`#fff`) — cream is the lightest value
- No box shadows as the primary depth mechanism (use borders/trim)
- No translucent/glass effects — hardware is opaque
- No rounded corners above 4px — hardware has edges
- No gradients as decoration — only as material simulation (brass, wood)
