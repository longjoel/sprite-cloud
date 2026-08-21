# Release Plan Update — Mobile-First Play & Beta Slip to October 1

> **Status:** DRAFT for review — not yet applied.
> **Driving feedback:** "Mobile experience for playing games is awful — iterate on it; fix the bad UI."
> **Plan owner:** Joel (maintainer).

## 1. What changes at a glance

| Item | Was | Now |
|---|---|---|
| Milestone title | Limited Beta — September 1, 2026 | Limited Beta — October 1, 2026 |
| Epic #658 title | …by September 1, 2026 | …by October 1, 2026 |
| BETA.md target date | September 1, 2026 | October 1, 2026 |
| Field-freeze gate | August 16 feature freeze | Move with the plan (no new P0 after freeze, ~mid-Sept) |
| Go/no-go window | August 29–31 | ~Sept 29–30 |
| Player-room program (#793) | Post-beta (deferred) | **Pre-release critical path, high priority** |
| Mobile play surface | Not claimed / supported | Becomes a claimed supported configuration |

## 2. Why

Critical tester/market feedback is that the mobile in-browser play experience is poor —
controls, layout, and discovery all need real iteration. That was scoped *post-beta*, but it's
now a release-quality concern. We are trading calendar time (Sept 1 → Oct 1) for a
mobile-first player experience, which is the right trade.

## 3. Scope change (requires epic amendment + same-change BETA.md update)

This is a **scope expansion**, so per BETA.md §3 it must be an epic amendment that updates
BETA.md in the same change. The player-room program stops being "explicitly deferred" and
becomes part of the beta deliverable.

### 3a. Pull into the critical path (high priority)
- **#796 — authoritative live room presence**
- **#797 — bounded ephemeral room chat**
- **#798 — MUI Save Center + safe save transfer**
- **#801 — self-hosted Storybook** (review environment for the above)
- Add mobile Portrait 390×844 and Landscape 844×390 to the supported matrix (they're in
  #799's verification matrix already — carry them into BETA.md §4).

### 3b. Keep deferred unless separately requested
- #705 (extend canonical self-hosting guide beyond beta matrix)
- ROM bundles / CHD, third-party sign-in (#645), public signup, Patreon/community launch
- #689 / #692 / #699–704 (capture-art, MAME, BIOS publishing) — post-beta content program

## 4. Proposed BETA.md edits

1. Line 3: "September 2026" → "October 2026".
2. Line 10–11: retitle milestone + target date → October 1, 2026.
3. §2 "Included workflows": add a **mobile browser play** item
   (launch, touch input, save/load, stop, second launch on portrait + landscape).
4. §3 "Explicitly deferred": remove the implicit post-beta status of #796/#797/#798 (via the
   #658 amendment); add explicit note that they are now in-scope.
5. §4 matrix: add mobile row (Android Chrome / iOS Safari, portrait + landscape)
   with the qualification evidence column.
6. §9 go/no-go window: August 29–31 → Sept 29–30.
7. §10 burndown: recount the release-blocker deliverables against #658 after the amendment.

## 5. Proposed epic #658 + milestone changes
- Retitle both to "October 1, 2026".
- Amend #658 body: add a child/blocker entry for the player-room program (#793) and the
  mobile-matrix closure; update the checklist.
- Reopen/mark the #793 children as release-path items.

## 6. Proposed new slice (optional, recommend adding)
A focused **"mobile-play usability closure"** slice that is deliberately independent of new
features (chat/Save Center still land but don't gate it): real-device pass on touch targets,
auto-layout, fullscreen containment, safe areas, on-screen controls ergonomics, and a
deterministic browser regression for at least the portrait touch path. This de-risks mobile
play even if #797/#798 slip.

## 7. Risks / open questions
- **Mobile is a big claim.** Qualifying Android Chrome + iOS Safari on the beta matrix is real
  device work; timebox it (Oct 1 is not far from Sept 1 + 30 days).
- **Chat/Save Center in beta** expands the security/SAVE surface — needs the #665 gate's
  exact-HEAD independent review applied to new code paths.
- **Do we keep desktop/controller as the "primary" promise and mobile as a qualified-add**, or
  flip mobile-first? Recommend: make mobile *qualified* (explicit supported list), not the only
  surface.
- Open: should #793 remain the umbrella epic or be renamed to reflect it's now a beta gate?

## 8. Verification before applying
- Confirm the exact milestone/epic bodies to patch (fetch, don't assume).
- Edit BETA.md + epic in the **same** change (epic-amendment rule).
- Independent review of the diff; then apply to origin/main path via PR (branch-protected).