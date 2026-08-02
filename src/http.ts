export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface HttpGet {
  (url: string, headers?: Record<string, string>): Promise<unknown>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseDelayMs: number },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < opts.retries) {
        await sleep(opts.baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

/** Real network GET returning parsed JSON. Retries on transient failure. */
export const httpGetJson: HttpGet = async (url, headers = {}) =>
  withRetry(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }, { retries: 3, baseDelayMs: 500 });

/** Real network GET returning raw text (for HTML pages). */
export async function httpGetText(
  url: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return withRetry(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }, { retries: 3, baseDelayMs: 500 });
}
