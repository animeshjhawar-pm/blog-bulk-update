/**
 * Hardcoded allow-list of clients this CLI / web UI will operate on.
 *
 * Adding a new client = a PR adding one entry here. There is no DB-driven
 * "any client" mode by design — keeps the blast radius of an accidental
 * regen on the wrong project to zero.
 *
 * Order in the home-page combobox follows insertion order. The five
 * featured clients (sentinel / specgas / trussed-ai / ach-engineering /
 * inzure) are pinned at the top — pre-fetched graphic_tokens for these
 * are committed to graphic-tokens/<slug>.json so Railway can read them
 * without re-running Firecrawl + Portkey on every cold start.
 *
 * `projectId` is the canonical UUID; the DB has no `slug` column on
 * `projects`, so the slug here is purely a local key the UI uses.
 */
export const CLIENTS = [
  { slug: "sentinel-asset-management", projectId: "a3af9ee4-e6c1-4003-a444-092618be6867" },
  { slug: "specgas",                   projectId: "c56bcf16-262c-41e4-8a34-4f14f7d4c579" },
  { slug: "trussed-ai",                projectId: "a79f81a9-4a5b-4d04-8ee0-ae49af926964" },
  { slug: "ach-engineering",           projectId: "b086fff5-629b-492a-97b8-07c3fae2b5b3" },
  { slug: "inzure",                    projectId: "84740989-2ad2-4c7e-9c9c-285f3aa7fce3" },
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
