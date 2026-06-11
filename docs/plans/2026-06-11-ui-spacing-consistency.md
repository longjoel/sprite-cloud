# UI Spacing & Rounding Consistency — Audit & Plan

> **Audit scope:** All views, CSS files, and Bootstrap utility usage across Games Vault.
> **Goal:** Normalize padding, margin, gap, border-radius, and border to a single set of design tokens used consistently everywhere.

---

## Audit Results

### 1. Border-radius — 4 competing systems

**Current state:**

| Source | Values used | Count |
|---|---|---|
| Design tokens (`--radius-*`) | sm=4px, md=6px, lg=8px, xl=12px, 2xl=16px | 6 uses total |
| Bootstrap `rounded` | 0.375rem (≈6px) | 6 uses |
| Bootstrap `rounded-4` | 0.5rem (≈8px) | 12 uses |
| Hardcoded rem | `1rem`, `1.5rem`, `0.85rem`, `0.75rem`, `0.3rem` | ~10 uses |
| Pill shape | `999px` | 15 uses (player HUD) |

**Problem:** Cards, alerts, inputs, and buttons use 4 different rounding systems interchangeably. A card might be `rounded-4` on one page and `rounded` on another. The design tokens exist but are barely referenced in actual CSS rules.

**Fix:** Phase out hardcoded rem values in favor of tokens. Standardize:
- Cards, alerts, modals → `var(--radius-lg)` (8px → should become 12px)
- Buttons, inputs, form controls → `var(--radius-md)` (6px)
- Pills, badges, player controls → keep `999px` (they're a distinct pill design)
- Update `--radius-lg` from 8px to 12px (matches Bootstrap `rounded-4`)

### 2. Card padding — no standard

**Current state:**

| Pattern | Where |
|---|---|
| `p-3` (1rem) | Small cards, arcade cards |
| `p-4` (1.5rem) | Detail cards, some game cards |
| `px-4 py-3` | Mixed |
| No padding class | Game bank cards (inherit `.card-body`) |

**Fix:** All `.card-body` elements should use `p-3` by default, `p-4` only for hero/promo cards. Remove mixed `px-4 py-3` combos.

### 3. Section margins — inconsistent stacking

**Current state:** `mb-3` dominates (65 uses), but mixed with `mb-1` (35), `mb-2` (26), `mb-4` (22), `mt-3` (27). No clear rule for when to use which.

**Fix:** 
- Section-to-section spacing: always `mb-4` (1.5rem)
- Within-section element spacing: `mb-3` (1rem)  
- Label-to-value spacing: `mb-1` (0.25rem)
- Card internal spacing: `mb-2` (0.5rem)

### 4. Gap values — too many unique sizes

**Current state:** 11 different custom gap values (`.18rem` through `1.25rem`) plus Bootstrap `gap-1`, `gap-2`, `gap-3`.

**Fix:**
- Card grids, section grids → `gap-3` (1rem)
- Button groups, inline chips → `gap-2` (0.5rem)
- Compact toolbars → `gap-1` (0.25rem)
- Remove all custom gap values in site.css (let Bootstrap handle it)

### 5. Shadows — missing consistency

**Current state:** `shadow-sm` on 19 elements, `shadow-lg` on 1. Cards sometimes have `shadow-sm`, sometimes don't.

**Fix:** All `.card` should have `shadow-sm`. Remove `shadow-lg`.

### 6. Custom CSS padding values — massive scatter

**Current state:** 55+ distinct `padding:` values in CSS. Many are near-duplicates:
- `.62rem .95rem` vs `.55rem .85rem` vs `.38rem .72rem` (player buttons)
- `.7rem .9rem` vs `.85rem 1rem` (panels)

**Fix for player HUD:** Normalize to 3 sizes:
- Large: `.625rem 1rem` (10px / 16px) — buttons, controls  
- Medium: `.5rem .75rem` (8px / 12px) — compact controls
- Small: `.375rem .625rem` (6px / 10px) — tiny elements

---

## Implementation Tasks

### Task 1: Standardize border-radius

**Files:** `wwwroot/css/site.css`

- Update `--radius-lg` from `8px` to `12px` (matches Bootstrap `rounded-4`)
- Replace all hardcoded `border-radius: 1rem` with `var(--radius-xl)`
- Replace `border-radius: 0.85rem` with `var(--radius-lg)`
- Replace `border-radius: 0.75rem` with `var(--radius-lg)`
- Replace `border-radius: 0.5rem` with `var(--radius-md)`
- Replace `border-radius: 0.3rem` with `var(--radius-sm)`
- In views: replace `rounded-4` with `rounded` (Bootstrap `rounded` = 0.375rem ≈ 6px, which maps to our `--radius-md`)
- Actually wait — Bootstrap `rounded-4` = 0.5rem = 8px. Our `--radius-lg` should be 12px. Cards should use `--radius-lg`. So cards get `rounded-4` for now, or we add a custom class. Let's keep `rounded-4` on cards and update the CSS variable for consistency.

Better approach:
- Set `--radius-lg: 0.5rem` (8px, matching Bootstrap `rounded-4`) — keep it since it's widely used
- Cards use `rounded-4` → maps to `--radius-lg`
- Buttons/inputs use `var(--radius-md)` (6px)
- Remove hardcoded `border-radius: 1rem` in `.games-card-art` → use `var(--radius-xl)` (12px)

### Task 2: Normalize card padding

**Files:** All views using `.card-body`

- All card bodies → `p-3` (1rem) by default
- Hero/promo cards → `p-4` (1.5rem)
- Remove `px-4 py-3` mixed combos

### Task 3: Standardize section margins

**Files:** All views

- Section-to-section: always `mb-4`
- Within-section: always `mb-3`  
- Label-to-value: `mb-1`
- Card internal: `mb-2`

### Task 4: Standardize gap usage

**Files:** `wwwroot/css/site.css`, all views

- Remove custom `gap:` properties from site.css
- Cards/grids: `gap-3`
- Button groups: `gap-2` 
- Compact: `gap-1`

### Task 5: Normalize player HUD padding

**Files:** `wwwroot/css/playserver.css`

- Player buttons: `.5rem .875rem` (consolidates `.62rem .95rem`, `.55rem .85rem`, `.38rem .72rem`)
- Compact controls: `.375rem .625rem`
- Panels: `.625rem .875rem`
- Reduce from 55+ unique padding values to 5-6 standard sizes

### Task 6: Audit and fix specific pages

Go page by page:
1. Landing page — verify hero/machine cards use standard tokens
2. Arcade page — verify cabinet cards consistent
3. Games library — verify game cards, bank, filters
4. Player session — sidebar, chat, seats (already mostly player.css — just normalize)
5. Admin — verify dashboard cards
6. Profiles — verify cards, forms
7. Modals — verify consistent padding/radius

### Task 7: Build, test, deploy

Run tests, fix any markup assertion failures, deploy.
