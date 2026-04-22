/**
 * SHARE-0 — extract a usable http(s) URL from an iOS/Android Web Share
 * Target payload.
 *
 * Priority:
 *   1. `url`  — Instagram sometimes drops the reel URL here.
 *   2. `text` — Facebook typically drops the URL here (sometimes
 *      embedded in multi-line caption text, so we fall back to a
 *      regex scan).
 *   3. `title` — last-resort fallback for share sources that stuff
 *      a link into the subject line.
 *
 * Security gates (the payload is attacker-controlled — anyone can
 * craft a share link):
 *   - Accepts only `http:` / `https:`. Rejects `javascript:`, `data:`,
 *     `file:`, `ftp:`, etc., so the rendered error path is the worst
 *     a hostile payload can achieve.
 *   - Caps at 2000 characters. Anything larger is almost certainly a
 *     garbage paste or an attempt to overflow downstream limits.
 */
const MAX_URL_LENGTH = 2000

function sanitise(candidate: string): string | null {
  if (candidate.length > MAX_URL_LENGTH) return null
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    const serialised = parsed.toString()
    if (serialised.length > MAX_URL_LENGTH) return null
    return serialised
  } catch {
    return null
  }
}

export function extractSharedUrl(params: URLSearchParams): string | null {
  for (const key of ['url', 'text', 'title'] as const) {
    const raw = (params.get(key) ?? '').trim()
    if (!raw) continue

    const direct = sanitise(raw)
    if (direct) return direct

    // Multi-line caption case: share sheets often drop the URL inside
    // free-form text ("Check this reel: https://fb.com/x 🔥"). Regex
    // pulls the first http(s) token out so we can still hand the user
    // a working import link. Excludes common terminal characters that
    // never appear in a URL path/query (whitespace, quotes, closing
    // brackets) so we don't over-capture trailing punctuation.
    const match = raw.match(/https?:\/\/[^\s<>"')\]]+/)
    if (match) {
      const extracted = sanitise(match[0])
      if (extracted) return extracted
    }
  }
  return null
}
