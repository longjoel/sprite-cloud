# Sprite Cloud Limited Beta — Operational Brief

**Canonical source of truth for the September 2026 limited beta.**
This document defines what is in scope, what is deferred, who may test, how
problems are reported and prioritized, and how the go/no-go decision is made.
If an issue or conversation contradicts this brief, this brief wins until the
epic is amended and this file is updated in the same change.

- **Parent epic:** [#658](https://github.com/longjoel/sprite-cloud/issues/658)
- **Milestone:** [Limited Beta — September 1, 2026](https://github.com/longjoel/sprite-cloud/milestone/3)
- **Target date:** September 1, 2026
- **Nature:** Invite-only, deliberately small cohort. **This is not a public launch.**

---

## 1. Eligibility

Access requires an invitation from an administrator. Invitees:

- Are known to the maintainer or a trusted administrator (no public signup).
- Enroll through the invite flow and immediately gain member access to the
  inviting administrator's server and game library. No self-hosting or pairing
  is required to try the beta.
- Use **only content they are authorized to use**. Project-controlled captures
  and deterministic tests use homebrew or public-domain fixtures.
- Report problems through the beta report template, not by asking the
  maintainer in private first (the template is the support route).

Anyone who cannot determine their eligibility, supported configuration,
reporting route, and expected limitations from this document should treat that
as a beta defect and report it.

## 2. Included workflows

The following are in scope and must work on a supported configuration:

1. Invite-based enrollment and immediate library access.
2. Clean host installation, setup, server pairing, service start, upgrade, and
   rollback on the supported beta matrix (§4).
3. Server-owned library discovery and browser launch using legally
   distributable homebrew/test content.
4. Desktop browser play, controller input, save/load, clean stop, and second
   launch.
5. Same-LAN, remote direct ICE, and forced TURN-relay connection paths.
6. The existing private guest/share flow where the tested runtime supports it.
7. The canonical setup/connectivity guide, known-limitations list, support
   route, and safe diagnostic collection (see `docs/STUN-TURN-ICE.md`).
8. Production backup/restore, monitoring, rollback, privacy notice, and the
   beta incident process.

## 3. Explicitly deferred (out of scope for this beta)

The following are **not** beta acceptance or support claims. Their
implementation may exist, but they do not count as beta-gate progress:

- Administrator ROM upload/download (epic #621). Implementation from #621 may
  exist; it is not part of beta acceptance.
- Third-party sign-in (epic #645 and children). Credentials remain the
  recovery-capable beta method.
- Multi-file ROM bundles (e.g. `.cue`/`.bin`, `.chd`).
- Public signup or unrestricted invitations.
- Patreon, Reddit, press, or broad community launch.
- Promising compatibility for untested browsers, hosts, cores, or game content.

Scope changes require an epic amendment that updates this file in the same
change. No new P0 scope after the **August 16 feature freeze** unless it fixes
a P0/P1 defect.

## 4. Supported host/client matrix

| Layer | Supported | Qualified evidence required |
|---|---|---|
| Host OS | Bazzite/Steam Deck-class, Debian/Ubuntu (x86-64), Raspberry Pi 5/ARM64 | Clean install reaches first game on each claimed host |
| Browser | Current Chromium-class desktop browser (Chrome/Edge/Brave), Firefox-class | Launch, input, save/load, stop, second launch |
| Network | Same-LAN, remote direct ICE, forced TURN relay | Each path proven; includes one cellular/hostile-NAT test |
| Cores/content | Homebrew/public-domain content; already-qualified cores only | No compatibility claims beyond tested set |

Anything not listed here is unsupported until separately qualified. Tester
reports on unqualified configurations are recorded but do not block the beta.

## 5. Cohort profile

Target **5–10 invited testers**:

- At least three people who did not build the product.
- At least one Bazzite/Steam Deck-class host.
- At least one Debian/Ubuntu host.
- At least one Raspberry Pi 5/ARM64 host **if** ARM64 remains advertised.
- At least one nontechnical install session observed without prematurely
  rescuing the participant.
- At least two remote-network tests, including one cellular/hostile-NAT path.

## 6. Severity definitions

| Severity | Meaning | Response |
|---|---|---|
| **P0** | Security/privacy boundary failure, data loss, corrupted install/upgrade, total supported-path launch failure, or unrecoverable service outage | Stop the beta or rollback |
| **P1** | Common supported workflow fails without a reasonable workaround | Fix before admitting additional testers |
| **P2** | Localized defect with a documented workaround | May carry with owner and target |
| **P3** | Polish or request | Record outside the beta-critical path |

A tester reporting a defect must classify severity; the maintainer may reclassify
based on this table.

## 7. Success metrics (privacy-preserving)

Metrics are aggregate and privacy-preserving. **No user-level analytics, no
persistent identifiers, no per-tester telemetry.** Every metric below has a
defined source; none requires a sensitive identifier.

| Metric | Source | Notes |
|---|---|---|
| Clean installs | Beta cohort install logs | Count, host type; no personal data |
| Time to first game | Install-to-launch session observations | Aggregate; no per-user tracking |
| Launches attempted / succeeded | Gateway session/launch records | Aggregated counts and rates |
| Route type (LAN / direct / relay) | Gateway connectivity diagnostic | Sanitized; no IPs or credentials |
| Categorized failure stage | Report template field | Failure category, not content |
| Save/load result | Report template field | Pass/fail per scenario |
| Support volume | Beta inbox / report template count | Counts by severity; no content retention |

No metric may be attributed to an individual tester without their explicit
opt-in, and none is required to participate.

## 8. Support route and safe diagnostics

- **Reporting route:** open an issue with the
  [beta report template](../.github/ISSUE_TEMPLATE/beta_report.yml) (or the
  linked template in the issue chooser). Include release/commit, host/client,
  route type, failure stage, sanitized logs, reproduction steps, and severity.
- **Do NOT include** in any report: ROM files or names you are not authorized
  to share, invite links, credentials/tokens, cookies, or personal data. Logs
  must be sanitized before upload.
- **Support destination:** the maintainer responds on the report issue.
  Private DMs are not the support route.
- **Incidents:** a P0 report triggers the beta incident process (stop/rollback
  evaluation, evidence capture, post-incident review) per #664/#668.

## 9. Go/no-go decision

- **Owner:** the maintainer (repository owner) makes the final GO/NO-GO on
  **August 29–31** after the #668 rehearsal.
- **Required for GO:**
  - All release-blocker children of #658 closed; epic checklist current.
  - No unresolved P0; no unresolved P1 without explicit workaround, owner, and
    post-beta issue.
  - At least three independent clean installs reach first game.
  - At least 20 cohort launch attempts with ≥90% success (excluding explicitly
    unsupported configurations); failures categorized, not discarded.
  - Direct ICE and forced TURN-relay gameplay both succeed on unrelated
    networks; LAN path passes.
  - Save/load, stop, restart, and second-launch paths pass.
  - Production backup restored into a clean database within the documented
    two-hour RTO (target RPO 24 hours).
  - Immutable release candidate passes CI, device/network checks,
    installer/download checksums, production deployment, rollback rehearsal,
    and independent fail-closed review.
  - Every tester knows the support route and what to redact.
- **A missed burndown target triggers scope reduction, not compressed testing.**

## 10. Burndown policy

- Count the eleven release-blocker deliverables in epic #658 (not subtasks,
  commits, or PRs).
- Close a deliverable only when its acceptance criteria are verified against
  current code/runtime.
- The epic's checklist is updated and a short evidence comment is posted when a
  child closes.
- Recount each Sunday.

## 11. Beta release-blocker checklist

Tracked in epic #658:

- [ ] #659 — Freeze the September limited-beta scope, cohort, metrics, and defect policy (this document)
- [ ] #660 — Make production TURN routing and connectivity diagnostics beta-ready
- [ ] #661 — Stamp immutable deployment provenance and prove web rollback
- [ ] #662 — Add a deterministic browser-to-emulator beta E2E harness
- [ ] #663 — Qualify clean install, upgrade, and service recovery on the beta platform matrix
  - [ ] #670 — Repair installer managed-path/update readiness (blocking sub-gate; reopened)
- [ ] #638 — Rewrite the canonical self-hosting and ICE/STUN/TURN setup journey (reused)
- [ ] #664 — Add limited-beta backups, restore rehearsal, monitoring, and incident operations
- [ ] #665 — Add the limited-beta security, privacy, account-lifecycle, and support gate
- [ ] #666 — Correct all limited-beta-facing claims, release notes, and support surfaces
- [ ] #667 — Run staged limited-beta cohorts and burn down evidence-backed defects
- [ ] #668 — Freeze, independently review, rehearse, and record the beta go/no-go decision
