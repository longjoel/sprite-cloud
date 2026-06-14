# ADR 006: Monorepo structure

**Status:** Accepted  
**Date:** 2026-06-14

## Context

Games Vault v2 consists of four components (gv-web, gv-server, gv-worker,
gv-player) that must stay in sync. Separate repos would require version
coordination and cross-repo PRs.

## Decision

Single monorepo with pnpm workspace (gv-web) and Cargo workspace (Rust
binaries). All components share the same `main` branch, protocol docs,
and issue tracker.

## Rationale

- **No version skew**: A change to the protocol (e.g., adding a new
  command type) is committed alongside the implementations in all
  affected components.
- **Shared docs**: Protocol spec, API reference, ADRs, and guides live
  in `docs/` — always in sync with the code.
- **Single CI**: One Jenkins pipeline tests everything. One `cargo test
  --workspace` covers all Rust code.
- **Atomic commits**: A feature that spans gv-web + gv-server + gv-worker
  is one commit, not three coordinated PRs across repos.

## Consequences

- Larger clone size (all components, even if you only work on one).
- Workspace configuration overhead (pnpm-workspace.yaml, root Cargo.toml).
- gv-player is a flat JS file in `gv-web/public/player/` — not a separate
  package. This keeps the player build-free while still living in the
  monorepo.
