# Security

If you find a security vulnerability in Games Vault, **do not open a
public issue.**

Instead, send details to **longjoel** via the [GitHub security
advisory form](https://github.com/longjoel/games-vault/security/advisories/new).

## Scope

- Authentication bypass or privilege escalation
- Remote code execution through a crafted game file or session
- Exposure of database credentials, TURN secrets, or cookie encryption keys
- XSS or CSRF in the web UI that could affect other users

Out of scope: minor information disclosure via timing side-channels,
presence of optional dependencies (e.g., coturn), or issues in
third-party emulator cores.

## Response

Vulnerabilities are acknowledged within 72 hours. A fix timeline is
provided after triage.
