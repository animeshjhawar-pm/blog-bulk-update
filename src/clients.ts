/**
 * Hardcoded allow-list of clients this CLI will operate on.
 *
 * Adding a new client = a PR adding one entry here. There is no DB-driven
 * "any client" mode by design — keeps the blast radius of an accidental
 * regen on the wrong project to zero.
 *
 * `projectIdHint` is informational. The CLI always re-resolves via the
 * SQL lookup (slug → id::text → url ILIKE) using the slug as the cache
 * key, but the hint lets a reviewer confirm the resolved row matches what
 * was intended at PR time.
 */
export const CLIENTS = [
  {
    slug: "sentinel-asset-management",
    projectIdHint: "a3af9ee4-e6c1-4003-a444-092618be6867",
  },
] as const;

export type ClientSlug = (typeof CLIENTS)[number]["slug"];

export interface ClientEntry {
  slug: string;
  projectIdHint: string;
}

export function findClient(slug: string): ClientEntry | undefined {
  return CLIENTS.find((c) => c.slug === slug);
}

export function clientSlugList(): string[] {
  return CLIENTS.map((c) => c.slug);
}
