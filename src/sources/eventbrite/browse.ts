import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

/** Evaluate an expression inside the live page and parse its JSON result. */
export async function browseEval<T>(expression: string): Promise<T> {
  const { stdout } = await run(BROWSE_BIN, ['js', expression], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

export async function readCsrfToken(): Promise<string> {
  const token = await browseEval<string | null>(
    `(document.cookie.match(/(?:^|;\\s*)csrftoken=([^;]+)/) || [])[1] || null`,
  );
  if (!token) {
    throw new Error('csrftoken cookie not found; load an eventbrite.com page first');
  }
  return token;
}

/**
 * POSTs from inside the page's own origin.
 *
 * Eventbrite's discovery API is WAF-blocked for server-side callers, so a Node
 * `fetch` from this process is rejected regardless of headers. Issuing the
 * request through the live browser session makes it a same-origin XHR carrying
 * the real cookie jar, which is what the WAF expects (spec §2.3).
 */
export function browsePostJson() {
  return async (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<unknown> =>
    browseEval(`(async () => {
      const res = await fetch(${JSON.stringify(url)}, {
        method: 'POST',
        credentials: 'include',
        headers: ${JSON.stringify(headers)},
        body: ${JSON.stringify(JSON.stringify(body))}
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    })()`);
}
