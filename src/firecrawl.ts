// ---------------------------------------------------------------------------
// Firecrawl provider — Step 1: scrape_client_site
//
// Uses Firecrawl v2 /scrape with the `branding` format (which returns the
// rich structured branding profile natively — colors, fonts, typography,
// spacing, components, images, personality). We do NOT parse HTML/CSS
// locally; we pass Firecrawl's output through.
//
// Reference: https://docs.firecrawl.dev/features/scrape#extract-brand-identity
// ---------------------------------------------------------------------------

export interface FirecrawlFont {
  family: string;
  /** Derived from typography.fontFamilies — "heading" or "body" when we can
   *  tell, otherwise omitted (we don't fabricate). */
  role?: "heading" | "body";
}

export interface FirecrawlBranding {
  colorScheme?: string;
  logo?: string;
  colors?: Record<string, string>;
  fonts?: FirecrawlFont[];
  typography?: {
    fontFamilies?: Record<string, string>;
    fontSizes?: Record<string, string>;
    fontWeights?: Record<string, number | string>;
    lineHeights?: Record<string, string>;
  };
  spacing?: Record<string, unknown>;
  components?: Record<string, unknown>;
  images?: {
    logo?: string;
    favicon?: string;
    ogImage?: string;
  };
  personality?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FirecrawlResult {
  branding: FirecrawlBranding;
  metadata: Record<string, unknown>;
  markdown: string;
}

export async function scrapeClientSite(url: string): Promise<FirecrawlResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "FIRECRAWL_API_KEY is not set. Local: add to .env.local and restart `npm run dev`. Vercel: add in Project Settings → Environment Variables, then redeploy."
    );
  }

  // Capped at 55s to fit inside Vercel Hobby's 60s function limit.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);

  let response: Response;
  try {
    response = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["branding", "markdown"],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 402) {
    throw new Error("Firecrawl quota exceeded (402). Check your plan limits.");
  }
  if (response.status === 429) {
    throw new Error("Firecrawl rate limit hit (429). Wait a moment and retry.");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Firecrawl error ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as {
    success: boolean;
    data?: {
      branding?: FirecrawlBranding;
      metadata?: Record<string, unknown>;
      markdown?: string;
    };
    error?: string;
  };

  if (!json.success) {
    throw new Error(`Firecrawl returned success:false — ${json.error ?? "unknown reason"}`);
  }

  const data = json.data ?? {};
  const rawBranding = data.branding ?? {};
  const metadata = data.metadata ?? {};
  const markdown = data.markdown ?? "";

  const branding: FirecrawlBranding = {
    ...rawBranding,
    fonts: annotateFontRoles(rawBranding),
  };

  return { branding, metadata, markdown };
}

/** Tag each font with role="heading" or role="body" by matching its family
 *  against typography.fontFamilies.{heading,primary,body}. Families that
 *  match neither are left without a role. */
function annotateFontRoles(branding: FirecrawlBranding): FirecrawlFont[] {
  const fonts = branding.fonts ?? [];
  const ff = branding.typography?.fontFamilies ?? {};
  const headingFamily = normalize(ff.heading);
  const bodyFamilies = new Set(
    [ff.primary, ff.body].map(normalize).filter((s): s is string => !!s)
  );

  return fonts.map((f) => {
    const key = normalize(f.family);
    if (!key) return f;
    if (headingFamily && key === headingFamily) return { ...f, role: "heading" };
    if (bodyFamilies.has(key)) return { ...f, role: "body" };
    return f;
  });
}

function normalize(s: string | undefined): string | undefined {
  if (!s) return undefined;
  // Strip quotes + fallback stack ("Halyard Display", sans-serif → halyard display)
  const head = s.split(",")[0] ?? s;
  return head.replace(/['"]/g, "").trim().toLowerCase();
}
