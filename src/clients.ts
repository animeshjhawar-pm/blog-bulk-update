/**
 * Hardcoded allow-list of clients this CLI / web UI will operate on.
 *
 * Adding a new client = a PR adding one entry here. There is no DB-driven
 * "any client" mode by design — keeps the blast radius of an accidental
 * regen on the wrong project to zero.
 *
 * `projectId` is the canonical UUID; the DB has no `slug` column on
 * `projects`, so the slug here is purely a local key the UI uses.
 */
export const CLIENTS = [
  {
    slug: "sentinel-asset-management",
    projectId: "a3af9ee4-e6c1-4003-a444-092618be6867",
  },
] as const;

export type ClientSlug = (typeof CLIENTS)[number]["slug"];

export interface ClientEntry {
  slug: string;
  projectId: string;
}

export function findClient(slug: string): ClientEntry | undefined {
  return CLIENTS.find((c) => c.slug === slug);
}

export function clientSlugList(): string[] {
  return CLIENTS.map((c) => c.slug);
}
