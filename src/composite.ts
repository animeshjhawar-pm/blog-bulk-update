import sharp from "sharp";
import type { AssetType } from "./pageInfo.js";

/**
 * Post-generation product compositor. Pastes the operator's product
 * image (verbatim — no re-encoding of the product pixels beyond
 * fit-resize) into a designated zone of an AI-generated background.
 *
 * The constraint that drives this file is "client's uploaded product
 * image must NOT be AI-generated or modified in any way": image-gen
 * models can't honor that directly (they always re-render whatever
 * they see), so we ask the model to render the SCENE with an empty
 * focal zone, then composite the real product pixels on top.
 *
 * Zone is asset-type aware so we match the visual contract the
 * existing wireframes (cover.png / thumbnail.png) already encode:
 *
 *   cover (16:9)    — product fills the RIGHT half (the visual zone
 *                     in the cover wireframe). Left half is reserved
 *                     for AI-rendered logo + title + subtitle + pill.
 *   thumbnail (3:2) — product is the hero, sized to ~88% of the
 *                     frame and centered. Background is environmental.
 *   everything else — centered, fits inside ~60% of canvas, preserving
 *                     product aspect. Service / category / inline blog
 *                     infographic all use this.
 *
 * Output is PNG so the composited product region is byte-exact (no
 * lossy WebP/JPEG ringing around the product edges). Downstream
 * resize-to-WebP-variants happens at Apply time and respects whatever
 * we produce here.
 */

export interface CompositeArgs {
  /** AI-generated background bytes (any sharp-readable format). */
  background: Buffer;
  /** Operator-uploaded product bytes (any sharp-readable format). */
  product: Buffer;
  /** Asset type — drives zone geometry. */
  asset: AssetType;
  /**
   * Optional hex (e.g. "#0072BB") used to recolor the LEFT HALF
   * background AFTER the AI returns. Only applied for cover and
   * thumbnail (the assets that use a left-text / right-product
   * layout). When supplied, every cover+thumbnail in the run gets
   * the same exact left-half background colour regardless of what
   * the AI chose to render. When omitted, the AI's bg is kept as-is.
   */
  leftHalfTargetColor?: string | null;
}

export interface CompositeResult {
  /** PNG bytes of the final composition. */
  bytes: Buffer;
  /** Final width/height for the log line. */
  width: number;
  height: number;
  /** The product zone we computed, in background coordinates. */
  zone: { left: number; top: number; width: number; height: number };
  /** Product's final rendered size after fit-resize (≤ zone). */
  productRendered: { width: number; height: number };
}

interface Zone {
  /** Fraction of canvas — [0, 1] each. */
  leftFrac: number;
  topFrac: number;
  widthFrac: number;
  heightFrac: number;
  /** Inset padding from the zone edges, fraction of zone width/height. */
  padFrac: number;
}

function zoneForAsset(asset: AssetType): Zone {
  switch (asset) {
    case "cover":
      // Right half of a 16:9 cover, edge-to-edge. Zero padding so
      // NO AI background shows behind/around the product — the
      // product image IS the right 50%. The left half (AI-rendered
      // text column) butts directly against the product's left edge.
      return { leftFrac: 0.5, topFrac: 0, widthFrac: 0.5, heightFrac: 1, padFrac: 0 };
    case "thumbnail":
      // Thumbnail layout mirrors cover: AI-rendered text/branding on
      // the LEFT half, product image on the RIGHT half, edge-to-edge.
      // This keeps the thumbnail visually consistent with its cover
      // and ensures the SpecGas-style branding stays visible (the
      // earlier full-canvas zone wiped out the AI's branding entirely).
      return { leftFrac: 0.5, topFrac: 0, widthFrac: 0.5, heightFrac: 1, padFrac: 0 };
    default:
      // Centered 72% — covers infographic / internal / external /
      // generic / service_h1 / service_body / category_industry.
      // These assets DO benefit from a narrow AI-rendered border
      // around the product (context framing), so a small pad stays.
      return { leftFrac: 0.14, topFrac: 0.14, widthFrac: 0.72, heightFrac: 0.72, padFrac: 0.03 };
  }
}

export async function compositeProduct(args: CompositeArgs): Promise<CompositeResult> {
  // Deterministic left-half recolor (cover + thumbnail only). Done
  // BEFORE the right-half product paste so the resize / zone math
  // below operates on the recoloured image. When the caller didn't
  // supply a target colour, or the asset isn't a cover/thumbnail,
  // this is a no-op and the AI's bg passes through unchanged.
  const sourceBg = (args.asset === "cover" || args.asset === "thumbnail")
    && args.leftHalfTargetColor
    ? await enforceLeftHalfColor(args.background, args.leftHalfTargetColor)
    : args.background;

  // Read both source dimensions up front so the resize math is in
  // background-pixel space (not normalized).
  const bgMeta = await sharp(sourceBg).metadata();
  const bgW = bgMeta.width ?? 0;
  const bgH = bgMeta.height ?? 0;
  if (!bgW || !bgH) {
    throw new Error(`composite: background has no dimensions (got ${bgW}x${bgH})`);
  }

  const zone = zoneForAsset(args.asset);
  const padPx = Math.round(Math.min(bgW * zone.widthFrac, bgH * zone.heightFrac) * zone.padFrac);
  const zoneLeft = Math.round(bgW * zone.leftFrac) + padPx;
  const zoneTop = Math.round(bgH * zone.topFrac) + padPx;
  const zoneW = Math.round(bgW * zone.widthFrac) - padPx * 2;
  const zoneH = Math.round(bgH * zone.heightFrac) - padPx * 2;
  if (zoneW <= 0 || zoneH <= 0) {
    throw new Error(`composite: zone collapsed (${zoneW}x${zoneH}) — background ${bgW}x${bgH}`);
  }

  // Single-layer composite: the product is cover-fitted to fill the
  // zone exactly. No backdrop, no white fill, no extras — just the
  // product image cropped (centre) to match the zone aspect.
  //
  // Centre crop is used (not attention/entropy) because it's
  // predictable across all product photos. For a wide product into
  // a narrow zone the left and right edges are trimmed equally; for
  // a tall product into a wide zone the top and bottom are trimmed
  // equally. The operator authorised cropping to make the fit work.
  //
  // EXIF rotation is honored via .rotate() so phone-camera photos
  // land the right way up.
  const fitted = await sharp(args.product)
    .rotate()
    .resize({
      width: zoneW,
      height: zoneH,
      fit: "cover",
      position: "centre",
    })
    .png()
    .toBuffer();

  const out = await sharp(sourceBg)
    .composite([{ input: fitted, left: zoneLeft, top: zoneTop }])
    .png()
    .toBuffer();

  const fittedW = zoneW;
  const fittedH = zoneH;
  const offsetLeft = zoneLeft;
  const offsetTop = zoneTop;

  return {
    bytes: out,
    width: bgW,
    height: bgH,
    zone: { left: zoneLeft, top: zoneTop, width: zoneW, height: zoneH },
    productRendered: { width: fittedW, height: fittedH },
  };
}

/**
 * Post-process the AI's output so the LEFT HALF background of a
 * cover/thumbnail is forced to the exact target colour, regardless of
 * what the model rendered. Asking the model to use a specific hex via
 * the prompt is unreliable (image-gen models routinely pick a colour
 * from the brand palette at random). Doing it here in pixel-space is
 * deterministic — every run renders with byte-identical background
 * colour across every cover and thumbnail.
 *
 * Algorithm:
 *   1. Extract the left half of the rendered image as raw RGBA.
 *   2. Sample three "quiet" regions (top-left corner, bottom-left,
 *      mid-left edge — places text/logos rarely land) to estimate
 *      the AI's actual background colour. Use the median to avoid
 *      being thrown off by stray text in any single sample.
 *   3. For each pixel in the left half, compute squared RGB distance
 *      to the sampled background. Pixels within DISTANCE_THRESHOLD
 *      are treated as "background" and rewritten to the target;
 *      pixels outside are "foreground" (text, logo, pill, etc.)
 *      and preserved bit-for-bit.
 *   4. Recompose left + right halves into the full image and return.
 *
 * The threshold is generous (~60 per channel) so AI-rendered
 * gradients and subtle background variation all collapse to the
 * target colour. Text and logos contrast sharply enough with their
 * background that they survive untouched.
 */
async function enforceLeftHalfColor(
  fullImage: Buffer,
  targetHex: string,
): Promise<Buffer> {
  const target = parseHex(targetHex);
  if (!target) return fullImage;

  const meta = await sharp(fullImage).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) return fullImage;
  const halfW = Math.floor(W / 2);
  if (halfW < 8 || H < 8) return fullImage;

  const { data, info } = await sharp(fullImage)
    .extract({ left: 0, top: 0, width: halfW, height: H })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels; // 4 with ensureAlpha
  const lw = info.width;
  const lh = info.height;

  // Three sample regions — corners + mid-edge — to be robust to stray
  // text in any one location. Each region is up to 24x24 px.
  const regions: Array<{ x: number; y: number; w: number; h: number }> = [
    { x: 0,                              y: 0,                                    w: Math.min(24, lw), h: Math.min(24, lh) },
    { x: 0,                              y: Math.max(0, lh - Math.min(24, lh)),   w: Math.min(24, lw), h: Math.min(24, lh) },
    { x: 0,                              y: Math.max(0, Math.floor(lh / 2) - 12), w: Math.min(8, lw),  h: Math.min(24, lh) },
  ];
  const reds: number[] = [], greens: number[] = [], blues: number[] = [];
  for (const r of regions) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * lw + x) * ch;
        reds.push(data[i] ?? 0);
        greens.push(data[i + 1] ?? 0);
        blues.push(data[i + 2] ?? 0);
      }
    }
  }
  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  const fromR = median(reds);
  const fromG = median(greens);
  const fromB = median(blues);

  // Per-channel threshold: ±60 each. Pixels within that box around
  // the sampled bg colour are reclassified as background and
  // rewritten. The threshold is generous enough that the AI's
  // subtle gradients collapse to a flat target colour. Text/logos
  // typically differ by >100 per channel so they survive.
  const TH = 60;
  const TH_SQ = TH * TH * 3;
  const out = Buffer.from(data); // mutable copy
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const dr = r - fromR;
    const dg = g - fromG;
    const db = b - fromB;
    if (dr * dr + dg * dg + db * db < TH_SQ) {
      out[i]     = target.r;
      out[i + 1] = target.g;
      out[i + 2] = target.b;
      // alpha untouched
    }
  }

  const recoloredLeft = await sharp(out, {
    raw: { width: lw, height: lh, channels: ch },
  }).png().toBuffer();

  const rightHalf = await sharp(fullImage)
    .extract({ left: halfW, top: 0, width: W - halfW, height: H })
    .png()
    .toBuffer();

  return sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .composite([
      { input: recoloredLeft, left: 0, top: 0 },
      { input: rightHalf, left: halfW, top: 0 },
    ])
    .png()
    .toBuffer();
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  let s = hex.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/**
 * The directive block we append to whatever asset prompt the build
 * pipeline already produces. Tells Replicate to leave the same zone
 * empty that `compositeProduct` will paste into. Phrased as a hard
 * constraint up top (matching how the BRAND_OPEN block in
 * buildPrompt.ts is positioned) so the model honors it even when
 * the base description implies a product subject.
 *
 * Per-asset wording mirrors `zoneForAsset` above — keep them in sync.
 * If you change one, change the other.
 */
export function emptyZoneDirective(asset: AssetType, brandColor: string | null = null): string {
  // Color clause used in cover + thumbnail directives. When the
  // caller passes a brandColor (typically the brand primary or
  // background_light from graphic_token), we embed the exact hex so
  // every image in the run gets the same left-half background.
  // Without this the AI picks freely per call — covers came back
  // white, thumbnails came back blue, even within the same run.
  // Falling back to "solid white" when no brandColor is supplied
  // still yields uniformity (every image will then be white).
  const targetColor = brandColor && /^#[0-9a-f]{3,8}$/i.test(brandColor)
    ? brandColor
    : "#FFFFFF";
  const colorClause =
    `LEFT-HALF BACKGROUND COLOR — HARD CONSTRAINT: fill the LEFT HALF of the canvas with the EXACT solid color ${targetColor}. ` +
    `This must be a single flat colour fill — no gradient, no texture, no pattern, no noise, no vignette, no shading variation. ` +
    `Use exactly this hex value: ${targetColor}. ` +
    `Apply this same background colour to EVERY image in this run for visual uniformity; do not vary the colour between cover and thumbnail or between clusters.`;

  switch (asset) {
    case "cover":
      return [
        "[PRODUCT COMPOSITE ZONE — HARD CONSTRAINT]",
        "The RIGHT HALF of this 16:9 canvas (from horizontal midpoint to right edge, full height) is RESERVED for a product photograph that will be composited onto the rendered image after generation.",
        "In the right half: render ONLY a clean, simple, uniform branded background (solid color, soft gradient, subtle brand pattern, or out-of-focus environmental scene). Do NOT render any product, packaging, illustration, photograph, mock-up, person, animal, text, or visual subject in the right half.",
        "The LEFT HALF carries all rendered content — logo, title, subtitle, pill — exactly as the cover wireframe defines.",
        colorClause,
        "FLAT SEAM: the left half and right half MUST sit flat against each other at the vertical midpoint. Do NOT render any drop shadow, inner shadow, soft shadow, dark edge, vignette, gradient fade, bevel, glow, depth effect, separator line, layered-card appearance, or floating-element treatment at or near the vertical midpoint or the left edge of the right half. The two halves are coplanar, not stacked.",
        "[/PRODUCT COMPOSITE ZONE]",
      ].join("\n");
    case "thumbnail":
      // Thumbnail uses the same left-text / right-product layout as
      // cover (the compositor pastes the product into the right half).
      // Directive is identical in shape to the cover directive so the
      // AI renders matching branding on the left.
      return [
        "[PRODUCT COMPOSITE ZONE — HARD CONSTRAINT]",
        "The RIGHT HALF of this canvas (from horizontal midpoint to right edge, full height) is RESERVED for a product photograph that will be composited onto the rendered image after generation.",
        "In the right half: render ONLY a clean, simple, uniform branded background (solid color, soft gradient, subtle brand pattern, or out-of-focus environmental scene). Do NOT render any product, packaging, illustration, photograph, mock-up, person, animal, text, or visual subject in the right half.",
        "The LEFT HALF carries all rendered content — logo, title, subtitle, pill — exactly as the cover wireframe defines.",
        colorClause,
        "FLAT SEAM: the left half and right half MUST sit flat against each other at the vertical midpoint. Do NOT render any drop shadow, inner shadow, soft shadow, dark edge, vignette, gradient fade, bevel, glow, depth effect, separator line, layered-card appearance, or floating-element treatment at or near the vertical midpoint or the left edge of the right half. The two halves are coplanar, not stacked.",
        "[/PRODUCT COMPOSITE ZONE]",
      ].join("\n");
    default:
      return [
        "[PRODUCT COMPOSITE ZONE — HARD CONSTRAINT]",
        "The CENTRAL 60% of the canvas (centered horizontally and vertically) is RESERVED for a product photograph that will be composited onto the rendered image after generation.",
        "In the central zone: render ONLY a clean, simple, uniform branded background (solid color, soft gradient, subtle brand pattern, or out-of-focus environmental scene). Do NOT render any product, packaging, illustration, photograph, mock-up, person, animal, text, or visual subject in the central zone.",
        "The surrounding ~20% border may carry context — environmental texture, brand elements, supporting details — that frames the product without distracting from it.",
        "[/PRODUCT COMPOSITE ZONE]",
      ].join("\n");
  }
}

/**
 * Pull a single deterministic background colour out of a graphic_token
 * blob so every cover+thumbnail in an Upload-&-Generate run renders
 * against the SAME left-half background. Returns null when no usable
 * value is found — callers should fall back to white in that case.
 *
 * The graphic_token schema isn't strictly defined; different clients'
 * tokens have different shapes (the extract step is heuristic). This
 * function probes the common paths in order of preference:
 *
 *   1. `colours.palette[role="primary"].hex`  — the most reliable in
 *      tokens emitted by the current extract_graphic_token prompt
 *      (e.g. SpecGas's #0072BB).
 *   2. `colors.palette[role="primary"].hex`   — same shape, US spelling.
 *   3. Any other entry whose role is one of the "background-ish" roles.
 *   4. Top-level convenience keys (primary_color, brand_color, etc.).
 *
 * Returns the hex string with a leading "#" or null. Never throws.
 */
export function extractRunBackgroundColor(token: unknown): string | null {
  if (!token || typeof token !== "object") return null;
  const t = token as Record<string, unknown>;
  const normalise = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (!s) return null;
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
    if (/^[0-9a-f]{6}$/i.test(s)) return "#" + s;
    return null;
  };

  // Palette probe — both spellings ("colours" / "colors") and both
  // shapes (array of {role, hex} or plain object keyed by role).
  for (const key of ["colours", "colors"] as const) {
    const node = t[key];
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    const palette = obj.palette;
    if (Array.isArray(palette)) {
      const byRole = (role: string) => {
        const hit = palette.find(
          (p) => p && typeof p === "object" && (p as { role?: unknown }).role === role,
        );
        return hit ? normalise((hit as { hex?: unknown }).hex) : null;
      };
      const primary = byRole("primary");
      if (primary) return primary;
      const heading = byRole("heading");
      if (heading) return heading;
      const bg = byRole("background_dark") || byRole("background") || byRole("background_light");
      if (bg) return bg;
    }
    // Plain-key shape: { primary: "#xxx", background: "#yyy", ... }
    const direct = normalise(obj.primary) || normalise(obj.brand) || normalise(obj.background);
    if (direct) return direct;
  }

  // Top-level convenience keys.
  const topLevel =
    normalise(t.primary_color) ||
    normalise(t.brand_color) ||
    normalise(t.background_color) ||
    normalise(t.cover_background_color);
  if (topLevel) return topLevel;

  return null;
}
