interface PlayerLocation {
  protocol: string;
  hostname: string;
  port: string;
  search: string;
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;

  const octets = match.slice(1).map((value) => Number.parseInt(value, 10));
  if (octets.some((value) => value < 0 || value > 255)) return false;

  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function isLanPlayerLocation(location: PlayerLocation): boolean {
  if (new URLSearchParams(location.search).get("route") === "lan") return true;

  return location.protocol === "http:"
    && location.port === "8787"
    && (location.hostname.endsWith(".local") || isPrivateIpv4(location.hostname));
}
