# PostHog usage analytics

PostHog powers DAU/retention dashboards and button-level telemetry ("which
buttons do users press, which ones don't they") for Sprite Cloud. It is
**strictly opt-in**: with no configuration, the app ships with zero analytics
code paths active — no keys, no hosts, no outbound connections.

## Status

| Question | Answer |
|---|---|
| Hard requirement? | **No.** Fully env-gated; unset vars = inert build |
| Backlog | Issue #753 |
| Leak protection | CI guard `tests/no-tracked-posthog-secrets.sh` fails on any tracked `phc_` key or concrete host |
| Privacy | Session replay OFF, no `identify()` → anonymous DAU only, autocapture never sends typed input values |

## How it works

- `sc-web/lib/posthog.ts` initializes the SDK **only** when both
  `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` were set at
  **build time** (Next inlines `NEXT_PUBLIC_*` into the client bundle).
- `sc-web/components/PostHogProvider.tsx` (mounted in the root layout)
  captures `$pageview` on mount and every route change, and autocapture
  records clicks/button presses with zero per-button code.
- The CSP in `next.config.ts` adds the analytics host to `connect-src` only
  when the host env var was present at build; otherwise the CSP stays fully
  closed.

## Option A — PostHog Cloud (free tier, ~5 minutes, zero infra)

1. Create a project at https://posthog.com (free tier: 1M events/month).
2. **Project Settings → Project API Key** → copy the `phc_...` key.
3. Your host is the region base URL:
   - US: `https://us.i.posthog.com`
   - EU: `https://eu.i.posthog.com`

## Option B — Self-hosted (full data control)

PostHog publishes an official hobby deployment compose:

```bash
# On a host with docker compose + ~4 GB free RAM
git clone --depth 1 https://github.com/PostHog/posthog
cd posthog
cp .env.example .env          # set DOMAIN, POSTHOG_SECRET, ENCRYPTION_SALT_KEYS
docker compose -f docker-compose.hobby.yml up -d
```

- Point `DOMAIN` at the analytics hostname (e.g. `analytics.sprite-cloud.com`)
  and terminate TLS at your reverse proxy.
- Create an admin account via the web UI, then create a project and copy its
  API key + host URL (`https://analytics.sprite-cloud.com`).

## Enabling for the deployment

1. Add two GitHub **secrets** to the repo (Settings → Secrets → Actions):
   - `POSTHOG_KEY` = the `phc_...` project key
   - `POSTHOG_HOST` = your analytics host (cloud or self-hosted)
2. Push to `main`. `deploy.yml` passes them as `--build-arg` into
   `Dockerfile.prod`, which bakes them into the client bundle at `next build`.
3. No secret = empty build arg = analytics stays off. Nothing to remove.

For local/dev testing, set the same two vars in `sc-web/.env.local`
(copy from `.env.example`) and run `pnpm dev`.

## Verifying it's live

1. Deploy with the secrets set.
2. Open the app in a browser and click around (library tiles, player, buttons).
3. In PostHog: **Live events** should show `$pageview` and `$autocapture`
   events within seconds.
4. **Product analytics → Trends** → `$pageview` (or `$autocapture`) for DAU:
   set the breakdown to `day` — the "100 daily active users" number lives
   here. **Retention** tab shows day-N retention curves.

## What's captured vs never captured

| Captured | Never captured |
|---|---|
| Pageviews (`$pageview`) | Typed input values (autocapture excludes them) |
| Clicks/button presses (`$autocapture`) | Session recordings (replay is off) |
| Anonymous device ID (`distinct_id`) | Email/account identity — no `identify()` calls |
| Page path + element structure/attributes | Real PostHog keys or hosts in the repo (CI-guarded) |

## Opting sensitive UI out of autocapture

Any element can be excluded per-element with the standard PostHog marker:

```tsx
<button data-ph-no-autocapture>Secret button</button>
```

## Failure mode

PostHog being down or unreachable never breaks Sprite Cloud: the SDK batches
events and drops them on failure; the app is unaffected. Analytics host is
only contacted when the CSP allows it (i.e. when configured).
