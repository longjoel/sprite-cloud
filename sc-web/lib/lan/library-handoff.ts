export interface LanLibraryLink {
  serverId: string;
  name: string;
  url: string;
}

interface ServerConnectivityRecord {
  serverId: string;
  name: string;
  metadata: unknown;
}

interface InterfaceInfo {
  name: string;
  address: string;
}

const VIRTUAL_INTERFACE = /^(?:br-|cni|docker|podman|veth|virbr)/i;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function interfacesFrom(metadata: Record<string, unknown>): InterfaceInfo[] {
  if (!Array.isArray(metadata.interfaces)) return [];
  return metadata.interfaces.flatMap((value) => {
    const entry = objectValue(value);
    return typeof entry?.name === "string" && typeof entry.address === "string"
      ? [{ name: entry.name, address: entry.address }]
      : [];
  });
}

function playerUrlsFrom(metadata: Record<string, unknown>): string[] {
  const lan = objectValue(metadata.lan);
  if (!Array.isArray(lan?.player_urls)) return [];
  return lan.player_urls.filter((value): value is string => typeof value === "string");
}

function safePlayerUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function extractLanLibraryLinks(records: ServerConnectivityRecord[]): LanLibraryLink[] {
  const seen = new Set<string>();
  const links: LanLibraryLink[] = [];

  for (const record of records) {
    if (seen.has(record.serverId)) continue;
    const metadata = objectValue(record.metadata);
    if (!metadata) continue;

    const interfaceByAddress = new Map(
      interfacesFrom(metadata).map((entry) => [entry.address, entry.name]),
    );
    const candidates = playerUrlsFrom(metadata)
      .map(safePlayerUrl)
      .filter((url): url is URL => url !== null)
      .sort((left, right) => {
        const leftName = interfaceByAddress.get(left.hostname);
        const rightName = interfaceByAddress.get(right.hostname);
        const leftVirtual = leftName ? VIRTUAL_INTERFACE.test(leftName) : false;
        const rightVirtual = rightName ? VIRTUAL_INTERFACE.test(rightName) : false;
        return Number(leftVirtual) - Number(rightVirtual);
      });

    const preferred = candidates[0];
    if (!preferred) continue;
    seen.add(record.serverId);
    links.push({
      serverId: record.serverId,
      name: record.name || "Sprite Cloud server",
      url: preferred.toString(),
    });
  }

  return links;
}
