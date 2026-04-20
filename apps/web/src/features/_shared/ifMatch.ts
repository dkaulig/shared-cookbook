/**
 * OFF4 — tiny helper that mirrors the backend's `ETagHelper.Compute(id,
 * version)` format (`W/"<id>-<version>"`).
 *
 * Kept inline (no dependency on a full ETag parser) because the
 * frontend only ever *emits* the header — the server's `TryParse` side
 * already handles the full grammar (strong/weak/quoted forms,
 * wildcard-star rejection, negative-version guard). A bad value would
 * land as `If-Match` garbage and the server would treat it as a missing
 * header, so the worst case is "no concurrency check this round".
 */
export function buildIfMatch(id: string, version: number): string {
  return `W/"${id}-${version}"`
}
