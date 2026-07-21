## LAN Play Observability

### Browser-launch event (live in DB)
```sql
SELECT event, detail, created_at
FROM launch_events
WHERE source = 'browser' AND event = 'launch_route_chosen'
ORDER BY created_at DESC
LIMIT 20;
```

### Server-side launch timeline
```sql
SELECT le.event, le.detail->>'flow' AS flow, le.detail->>'route' AS route,
       le.created_at, s.name AS server, le.game_id
FROM launch_events le
LEFT JOIN servers s ON s.id = le.server_id
WHERE le.event IN ('command_enqueued', 'command_leased', 'session_created', 'sdp_exchange_ok', 'launch_route_chosen')
ORDER BY le.created_at DESC
LIMIT 50;
```

### Grafana / Loki queries (sc-server logs)
```
# Did we use LAN or relay?
{service="sc-server"} |= "ICE connection state changed: connected"
  | json | line_format "{{.fields.message}}"

# Any core download failures?
{service="sc-server"} |= "core download failed"
  | json | line_format "{{.fields.message}}"

# SDP exchange timing
{service="sc-server"} |= "SDP exchange OK"
  | json | line_format "attempt={{.fields.attempt}} ms={{.fields.duration_ms}}"
```

### Test matrix (manual verification)

| Scenario | Expected route | Evidence |
|---|---|---|
| Desktop Chrome on LAN → sc-server HTTP health probe | LAN direct | Library shows "reachable" badge, `route=lan` in URL |
| HTTPS page → HTTP LAN probe blocked | Relay fallback | Library shows "blocked" badge, opens player via relay |
| Both Vault + Bazzite online, user selects Bazzite | LAN direct to Bazzite | Host picker shows both, player URL matches selected server |
| Mobile on cellular → LAN server unreachable | Relay via TURN | No LAN badge, player opens via relay |
