import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Prefix for the sibling temp file every atomic write goes through.
 *
 *   <dir>/.atomic-tmp-<basename>-<pid>-<rand>
 *
 * The leading dot and the trailing -<pid>-<rand> are both load-bearing.
 * The temp file has to fall outside EVERY directory filter in this
 * repo, or a reader picks it up mid-write and we've swapped one
 * corruption mode for another:
 *
 *   - manifest scans (retention.ts, web.ts x4) require
 *     endsWith(".json"). The trailing random suffix means a temp never
 *     ends in .json, so a half-written manifest is never scanned.
 *   - the product + wireframe serving routes pick a file with
 *     names.find(n => n.startsWith(imageId + ".")) — see
 *     web.ts serveProduct / serveWireframe. The OBVIOUS temp name,
 *     `${target}.tmp-…` (what tokens.ts and uploadRun.ts used before
 *     this module existed), DOES match that prefix: applying it to the
 *     image writes would let the server hand a viewer a truncated
 *     photo. Prefixing the basename instead of suffixing it sidesteps
 *     the whole class.
 *   - retention's sidecar sweeps are anchored regexes
 *     (/^products-([a-f0-9]+)\.json$/, the prompt-override/extra/
 *     prompt-per-image alternation) that a prefixed name cannot match.
 *
 * The price of being invisible to those filters is that a hard crash
 * between write and rename leaves an orphan behind. sweepAtomicTmpFiles
 * in retention.ts collects them under runOutDir(). Orphans outside that
 * tree are NOT collected today: GRAPHIC_TOKEN_DIR (tokens.ts) and the
 * cwd/out paths in rehost.ts and gemini.ts fall outside it. They are
 * tiny and rare, but the sweep does not reach them.
 */
export const ATOMIC_TMP_PREFIX = ".atomic-tmp-";

/** The sibling path writeFileAtomic would stage `target` through. */
export function atomicTmpPathFor(target: string): string {
  return path.join(
    path.dirname(target),
    `${ATOMIC_TMP_PREFIX}${path.basename(target)}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
}

/**
 * Write a file all-or-nothing: either the full new content lands at
 * `target`, or the previous content is left untouched. Never a
 * truncated file.
 *
 * Why this exists (incident 2026-09-11): fs.writeFile opens with
 * O_TRUNC, which zeroes the target BEFORE writing a single byte. The
 * /data volume hit 100% and every write in flight at that moment left
 * an empty file behind — three run manifests that parsed as
 * "Unexpected end of JSON input" on the next boot, and one project's
 * saved overrides that crashed its workspace page on every load. Both
 * files were perfectly readable. Both were zero bytes.
 *
 * Write-to-sibling-then-rename fixes it because rename(2) within one
 * filesystem is atomic: a reader sees the old inode or the new one,
 * never a partial one. ENOSPC now fails the temp write, the original
 * survives, and the error reaches the caller instead of being silently
 * baked into the file.
 *
 * The fsync before rename covers the crash case: without it the rename
 * can reach disk before the data does, which after a hard kill leaves
 * an intact-looking file full of zeros.
 *
 * The one deliberate exception in this repo is the per-run CSV
 * (csv.ts): the run page streams it WHILE the run is still writing
 * rows, so it must exist at its final path throughout and cannot be
 * staged. See the comment there for what guards it instead.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Buffer,
  encoding: BufferEncoding = "utf8",
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = atomicTmpPathFor(target);
  try {
    // "wx" = fail if it somehow exists; the random suffix makes that
    // essentially impossible, but it keeps two concurrent writers from
    // ever sharing a staging file.
    const fh = await fs.open(tmp, "wx", 0o644);
    try {
      await fh.writeFile(data, typeof data === "string" ? encoding : null);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, target);
  } catch (err) {
    // Best effort. On a full volume the unlink can fail too, and the
    // caller's error matters more than the orphan — retention sweeps it.
    await fs.rm(tmp, { force: true }).catch(() => { /* best effort */ });
    throw err;
  }
}
