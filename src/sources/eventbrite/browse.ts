import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BROWSER_UA } from '../../http.js';

const run = promisify(execFile);

const PLACE_ID_RE = /"placeId"\s*:\s*"(\d+)"/;
const APP_VERSION_RE = /"app_version"\s*:\s*"([^"]+)"/;
const SERVER_DATA_MARKER = 'window.__SERVER_DATA__';

export interface EventbriteServerData {
  placeId?: string;
  app_version?: string;
  search_data?: { events?: { results?: Array<Record<string, unknown>> } };
}

export function extractPlaceId(html: string): string | null {
  return PLACE_ID_RE.exec(html)?.[1] ?? null;
}

/** Recorded per run so a version bump shows up as drift (spec §7). */
export function extractAppVersion(html: string): string | null {
  return APP_VERSION_RE.exec(html)?.[1] ?? null;
}

/**
 * Extracts the `window.__SERVER_DATA__` object from an Eventbrite page.
 *
 * This brace-counts to the matching close rather than matching a regex up to
 * `</script>`, because the live page assigns more than one global inside a
 * single script block:
 *
 *     window.__SERVER_DATA__ = { ... };
 *     window.__REACT_QUERY_STATE__ = { ... };
 *     </script>
 *
 * A lazy `[\s\S]*?` anchored on `</script>` therefore runs straight past the
 * real boundary and captures hundreds of KB of unrelated JavaScript, which then
 * fails to parse. That version passed against a synthetic single-assignment
 * fixture and returned null on every real page — so the regression test below
 * uses the two-assignment shape the site actually serves.
 *
 * String and escape handling matters: a brace inside a quoted event title would
 * otherwise unbalance the count.
 */
export function extractServerData(html: string): EventbriteServerData | null {
  const markerAt = html.indexOf(SERVER_DATA_MARKER);
  if (markerAt === -1) return null;

  const open = html.indexOf('{', markerAt + SERVER_DATA_MARKER.length);
  if (open === -1) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = open; i < html.length; i++) {
    const ch = html[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(open, i + 1)) as EventbriteServerData;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

const BROWSE_BIN =
  process.env.BROWSE_BIN ?? '/Users/pascal/.claude/skills/gstack/browse/dist/browse';

export async function browseGoto(url: string): Promise<void> {
  await run(BROWSE_BIN, ['goto', url], { maxBuffer: 64 * 1024 * 1024 });
}

export async function browseHtml(): Promise<string> {
  const { stdout } = await run(BROWSE_BIN, ['html'], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Interprets `browse js` stdout.
 *
 * The binary prints objects, arrays, numbers and null as JSON, but prints
 * strings **bare** — `'hello'` comes back as `hello`, not `"hello"`. Parsing
 * stdout as JSON unconditionally therefore throws on every string result,
 * which is how reading the csrftoken cookie failed: the token was retrieved
 * correctly and then discarded by a SyntaxError.
 *
 * A failed parse means the value was a plain string, so fall back to the raw
 * text rather than treating it as an error.
 */
export function parseBrowseOutput<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return trimmed as unknown as T;
  }
}

/** Evaluate an expression inside the live page and return its result. */
export async function browseEval<T>(expression: string): Promise<T> {
  const { stdout } = await run(BROWSE_BIN, ['js', expression], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseBrowseOutput<T>(stdout);
}

/** Full `document.cookie` string from the live session, for replay from Node. */
export async function readCookieHeader(): Promise<string> {
  const cookies = await browseEval<string>('document.cookie');
  if (!cookies || !cookies.includes('csrftoken=')) {
    throw new Error('csrftoken cookie not found; load an eventbrite.com page first');
  }
  return cookies;
}

/** Pull the CSRF token out of a cookie header string. */
export function csrfFromCookies(cookieHeader: string): string | null {
  return /(?:^|;\s*)csrftoken=([^;]+)/.exec(cookieHeader)?.[1] ?? null;
}

export async function readCsrfToken(): Promise<string> {
  const token = csrfFromCookies(await readCookieHeader());
  if (!token) {
    throw new Error('csrftoken cookie not found; load an eventbrite.com page first');
  }
  return token;
}

/**
 * POSTs to Eventbrite from Node, replaying the browser session's cookie jar.
 *
 * Third-party recon notes describe this API as WAF-blocked server-side, which
 * is why an earlier version issued the request from inside the page. Verified
 * false on 2026-08-02: a plain Node POST carrying the browser's cookies, the
 * CSRF token and an Origin header returns HTTP 200 with a full result set
 * (object_count 4413 for SF).
 *
 * The in-page route was also unusable in practice — the browse binary's `js`
 * command returns empty output for any expression containing `fetch`, because
 * it does not await network promises. The browser is needed only to obtain
 * cookies and the placeId, never to issue requests.
 */
export function cookiePostJson(cookieHeader: string) {
  return async (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<unknown> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        Cookie: cookieHeader,
        Origin: 'https://www.eventbrite.com',
        'User-Agent': BROWSER_UA,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  };
}
