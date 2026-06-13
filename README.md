# Games Vault

Retro game library and browser-based streaming. Monorepo.

## Architecture

```
gv-web          Next.js website (hosting, auth, library management)
gv-player       JavaScript client for playing games in-browser
gv-server       Rust binary — runs on the user's computer, serves ROM library
gv-worker       Rust binary — per-game worker process launched by gv-server
```

## Reference

The previous ASP.NET Core monolith lives on `main`. `git checkout main` to browse.

## Status

Early development.
