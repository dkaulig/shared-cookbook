/**
 * SHARE-0 + SHARE-2 — extract usable http(s) URL(s) from an iOS/Android
 * Web Share Target payload.
 *
 * The share-sheet payload is attacker-controllable (anyone can craft
 * a share link / caption). Both exports apply the same per-URL
 * sanitise rules:
 *   - Accept only `http:` / `https:`. Reject `javascript:`, `data:`,
 *     `file:`, `ftp:`, etc.
 *   - Cap each URL at 2000 chars.
 *
 * SHARE-0 `extractSharedUrl` returns the first usable URL or null —
 * used by the SHARE-0 single-URL redirect path.
 * SHARE-2 `extractSharedUrls` returns all usable URLs (deduped, up to
 * 10) across `url`/`text`/`title` — used by the multi-URL picker.
 */
const MAX_URL_LENGTH = 2000
const MAX_URL_COUNT = 10
// Same token as the SHARE-0 regex fallback — stops at whitespace,
// quotes, angle brackets, closing parens/brackets so we don't
// over-capture trailing punctuation from free-form captions.
const URL_TOKEN_RE = /https?:\/\/[^\s<>"')\]]+/g

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

/**
 * Collect every http(s) URL candidate from `url` + `text` + `title`,
 * regex-match additional tokens inside free-form text, sanitise each,
 * dedupe by string equality, and cap at {@link MAX_URL_COUNT}.
 *
 * Ordering: params are visited in `url` → `text` → `title` order and
 * within each value, the direct-sanitise hit comes before the regex
 * tokens — so `?url=https://a` + `?text=https://b https://a` yields
 * `[a, b]`.
 */
export function extractSharedUrls(params: URLSearchParams): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  function push(candidate: string | null): boolean {
    if (!candidate) return false
    if (seen.has(candidate)) return false
    seen.add(candidate)
    out.push(candidate)
    return out.length >= MAX_URL_COUNT
  }

  for (const key of ['url', 'text', 'title'] as const) {
    const raw = (params.get(key) ?? '').trim()
    if (!raw) continue

    // Direct sanitise — the value might be a bare URL. Guarded by
    // the no-whitespace check: `new URL("https://a.example/0 …")`
    // percent-encodes the embedded space into a single "URL", which
    // would swallow the rest of the caption's URLs into one entry.
    if (!/\s/.test(raw) && push(sanitise(raw))) return out

    // Regex sweep — captions often embed one or more URLs in prose.
    // Use String.prototype.matchAll so we don't have to reset a
    // shared RegExp's lastIndex between calls.
    for (const match of raw.matchAll(URL_TOKEN_RE)) {
      if (push(sanitise(match[0]))) return out
    }
  }

  return out
}

/**
 * SHARE-0 single-URL entry point — kept as a thin wrapper so callers
 * that only care about the first usable URL (the silent-redirect
 * branch) don't have to unpack a list.
 */
export function extractSharedUrl(params: URLSearchParams): string | null {
  return extractSharedUrls(params)[0] ?? null
}
