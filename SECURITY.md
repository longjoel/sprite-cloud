# Security Policy

## Supported versions

Sprite Cloud is pre-1.0. Security fixes are applied to the latest `main` branch unless otherwise stated in a release note.

## Reporting a vulnerability

Please do **not** report security vulnerabilities in public GitHub issues.

Until a dedicated security contact is published, report privately to the project maintainer.

Include:

- Affected component (`sc-web`, `sc-server`, `sc-core`, installer, deployment config)
- Impact
- Reproduction steps
- Logs or screenshots if useful
- Whether credentials, tokens, pairing codes, saves, or user libraries are exposed

## Scope

Security-sensitive areas include:

- Authentication and signup/setup flow
- Pairing codes and server registration
- Session authorization
- WebRTC signaling and TURN credentials
- File-system access to ROM libraries and saves
- Installer and systemd service behavior
- Docker/deployment configuration

## Out of scope

- Vulnerabilities requiring already-compromised host/root access
- Issues in third-party emulator cores or user-provided ROMs
- Denial-of-service from intentionally running extremely heavy games/cores on underpowered hardware
- Reports involving pirated or unauthorized game content
