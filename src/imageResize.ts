import sharp from "sharp";

/**
 * Three canonical web variants matching gw-backend-stormbreaker's
 * `services/image/image.py :: ImageService.convert_and_upload_as_webp`.
 *
 *   1080 px width — desktop hero
 *    720 px width — tablet
 *    360 px width — mobile
 *
 * Width is the constraint; height follows from the source aspect
 * ratio (no padding, no cropping — a 1:1 source resized to 720 px
 * becomes 720×720, a 16:9 becomes 720×405). `withoutEnlargement: true`
 * means a source smaller than 1080 px is left at its native size for
 * that variant (preserves quality; we never upscale).
 *
 * Encoding: lossy WebP at quality 80 — same as stormbreaker (line 97
 * of the same file: "output_quality": 80).
 */
export const VARIANT_WIDTHS = [1080, 720, 360] as const;
export type VariantWidth = (typeof VARIANT_WIDTHS)[number];

export interface ImageVariant {
  width: VariantWidth;
  /** Final WebP bytes ready to upload. */
  bytes: Buffer;
  /** Byte length — exposed for the caller's log line / response. */
  size: number;
}

const WEBP_QUALITY = 80;

/**
 * Resize a source image into all three canonical variants, in
 * parallel. Source can be any format sharp understands (PNG, JPEG,
 * WebP, AVIF, etc.) — Replicate gives us PNG today; converting to
 * WebP at quality 80 typically yields ~30 % file-size reduction at
 * equivalent visual quality.
 */
export async function resizeToWebpVariants(
  source: Buffer,
): Promise<ImageVariant[]> {
  return Promise.all(
    VARIANT_WIDTHS.map(async (width) => {
      const bytes = await sharp(source)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      return { width, bytes, size: bytes.length };
    }),
  );
}
