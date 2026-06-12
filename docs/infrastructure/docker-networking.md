# Docker networking & `network_mode: host`

## Why host networking?

`docker-compose.yml` uses `network_mode: "host"` because Games Vault
launches nosebleed subprocesses that each bind a WebRTC UDP listen port:

```
BaseListenPort + sessionIndex  (for sessionIndex in 0 .. MaxSessions-1)
```

With defaults (`BaseListenPort=8100`, `MaxSessions=4`) that range is:

| Port      | Purpose                  |
|-----------|--------------------------|
| 8100      | Session 0 (UDP)          |
| 8101      | Session 1 (UDP)          |
| 8102      | Session 2 (UDP)          |
| 8103      | Session 3 (UDP)          |

These ports are dynamic — they change when users configure
`Nosebleed__BaseListenPort` or `Nosebleed__MaxSessions`.

**Host networking** avoids the need to publish every port explicitly in
`docker-compose.yml`. Without it, every port in the range would need a
`ports:` entry, and the mapping would break the moment someone changes
`MaxSessions` or `BaseListenPort`.

---

## Security implications

Host networking gives the container access to the host's full network
stack — i.e., the container can bind *any* port and can see *all* host
network interfaces. For a single-service machine this is acceptable, but
it reduces the isolation that Docker normally provides.

If you run other containers on the same host (e.g. Traefik, coturn), the
app container's ports are visible to them without any `ports:` mapping,
which is fine — but the app container can also interfere with ports the
host or other containers are using.

---

## Alternatives (stricter isolation)

### Option A — Individual port mappings (static range)

Publish the port range explicitly. This is simple but brittle — you must
update the list any time `MaxSessions` or `BaseListenPort` changes.

```yaml
  app:
    ports:
      - "8080:8080"           # HTTP
      - "8100:8100/udp"       # Nosebleed session 0
      - "8101:8101/udp"       # Nosebleed session 1
      - "8102:8102/udp"       # Nosebleed session 2
      - "8103:8103/udp"       # Nosebleed session 3
```

> **Limitation:** There is no `docker-compose` syntax to publish a dynamic
> numeric range (`8100–8103`). Port ranges in the Docker CLI
> (`8100-8103:8100-8103/udp`) are only available via `docker run`, not
> in the Compose specification.

### Option B — Port range via `docker run` (ad-hoc start)

If you don't use Compose, you can publish a range directly:

```bash
docker run --rm -p 8080:8080 -p 8100-8103:8100-8103/udp games-vault
```

### Option C — macvlan network

Give the container its own IP on the LAN. No port publishing needed, and
isolation is preserved (the container gets its own network namespace).

```yaml
  app:
    networks:
      gv_net:
        ipv4_address: 192.168.1.50

networks:
  gv_net:
    driver: macvlan
    driver_opts:
      parent: eth0
    ipam:
      config:
        - subnet: "192.168.1.0/24"
          gateway: "192.168.1.1"
```

Then point `Nosebleed__PublicHost` at the macvlan IP instead of the host IP.

> **Limitation:** macvlan cannot communicate with the host itself without
> additional bridge rules. If the database is on the host (e.g.
> `postgres://127.0.0.1`), the container won't reach it.

### Option D — Docker bridge + host port mapping (recommended for new setups)

The practical middle ground: put the app on the default bridge network and
publish only the HTTP port plus a generous UDP range:

```yaml
  app:
    ports:
      - "8080:8080"
      - "8100-8110:8100-8110/udp"
```

Then set `Nosebleed__MaxSessions` to match the port count. This works
with `docker compose` even though the range syntax is technically for
`docker run` — Compose 2.x supports the hyphen syntax.

---

## Runtime check

To confirm which ports nosebleed actually bound at runtime:

```bash
# On the Docker host (host networking)
ss -tulpn | grep nosebleed

# Inside the container (any networking mode)
docker exec games-vault-app-1 ss -tulpn
```

Look for UDP listen sockets starting at `Nosebleed__BaseListenPort`.

---

## Port layout summary

| Port(s)      | Protocol | Component       | Configurable?         |
|--------------|----------|-----------------|-----------------------|
| 8080         | TCP      | ASP.NET (HTTP)  | `ASPNETCORE_URLS`     |
| 8100-N       | UDP      | Nosebleed ICE   | `Nosebleed__BaseListenPort` + `__MaxSessions` |
