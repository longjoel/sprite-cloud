# Contributing

Thanks for considering contributing to Games Vault.

## Quick start

```bash
git clone https://github.com/longjoel/games-vault.git
cd games-vault
dotnet restore
dotnet build
```

See [README.md](README.md) for Docker quick-start and full setup.

## Before you submit

- **One change per PR.** Splitting unrelated improvements into separate
  PRs keeps review focused.
- **Tests must pass.** Run `dotnet test` before pushing.
- **No secrets in code.** Connection strings, API keys, hostnames go in
  environment variables or `.env`.
- **UI copy** should be terse. Single-word labels, no marketing prose.
- **Commit messages** follow the conventional format:

```
area: short summary

Optional body with details, rationale, or migration notes.
```

Areas: `docs`, `feat`, `fix`, `refactor`, `ci`, `infra`, `style`.

Example: `feat: add TURN credential service for per-session auth`

## Code style

- `.editorconfig` handles formatting. Most editors pick it up
  automatically.
- C#: 4-space indentation, file-scoped namespaces, implicit usings.
- JavaScript/HTML/CSS: 2-space indentation.
- Prefer `var` when the type is obvious.

## Running tests

```bash
# Requires a PostgreSQL instance (see README)
ConnectionStrings__DefaultConnection="Host=localhost;..." dotnet test
```

The CI workflow runs the same command on every push.
