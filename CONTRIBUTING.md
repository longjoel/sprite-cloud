# Contributing to Sprite Cloud

Thanks for helping build Sprite Cloud.

Sprite Cloud is open source under the **GNU Affero General Public License v3.0 or later**. Because the project may also offer commercial licensing, contributions require agreement to the project CLA.

## Before opening a PR

1. Read [`LICENSE`](LICENSE).
2. Read [`CLA.md`](CLA.md).
3. Make sure your PR description includes:

```text
I agree to the Sprite Cloud Contributor License Agreement in CLA.md.
```

Do not submit code you cannot license under the CLA.

## Development setup

### Rust services

```bash
cargo build --workspace
cargo test --workspace
```

### Web app

```bash
cd sc-web
pnpm install
pnpm test
pnpm build
```

## Contribution rules

- Keep implementations simple and direct.
- Do not commit ROMs, BIOS files, commercial game assets, generated bundles, `.env` files, credentials, database dumps, or build artifacts.
- Do not hardcode deployment domains. Use configurable origins or neutral examples such as `https://your-gateway.example`.
- Prefer source-built, reproducible changes over checked-in binaries.
- Include tests for auth, pairing, session startup, and protocol changes when practical.
- Update docs when behavior changes.

## Licensing requirements

New dependencies must be compatible with AGPLv3-or-later distribution.

Generally acceptable:

- MIT
- BSD
- ISC
- Apache-2.0
- LGPL libraries used dynamically, such as system GStreamer packages

Ask before adding:

- GPL/AGPL components copied into the repo
- Commercial SDKs
- Code with unclear provenance
- Assets, ROM metadata, covers, screenshots, or database dumps with unclear rights

## Security issues

Do **not** open public issues for vulnerabilities. See [`SECURITY.md`](SECURITY.md).

## Pull request checklist

- [ ] I agree to the Sprite Cloud Contributor License Agreement in `CLA.md`.
- [ ] I did not commit secrets, ROMs, BIOS files, generated bundles, or build artifacts.
- [ ] I updated docs for user-visible behavior changes.
- [ ] I ran the relevant tests/builds.
- [ ] I noted any migrations or deployment steps.
