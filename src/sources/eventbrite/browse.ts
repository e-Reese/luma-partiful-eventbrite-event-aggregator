import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PLACE_ID_RE = /"placeId"\s*:\s*"(\d+)"/;
const APP_VERSION_RE = /"app_version"\s*:\s*"([^"]+)"/;
const SERVER_DATA_RE = /window\.__SERVER_DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/;

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

export function extractServerData(html: string): EventbriteServerData | null {
  const match = SERVER_DATA_RE.exec(html) ?? /window\.__SERVER_DATA__\s*=\s*(\{[\s\S]*?\});/.exec(html);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as EventbriteServerData;
  } catch {
    return null;
  }
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
