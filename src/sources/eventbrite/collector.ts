import {
  browseGoto, browseHtml, cookiePostJson, csrfFromCookies,
  extractAppVersion, extractPlaceId, readCookieHeader,
} from './browse.js';
import { fetchEventbrite } from './fetch.js';
import type { FetchResult } from '../../types.js';

const BROWSE_URL = 'https://www.eventbrite.com/d/ca--san-francisco/events/';

/**
 * Loads the SF browse page in the live browser session to resolve the internal
 * placeId and the cookie jar, then pages the search API from Node replaying
 * those cookies.
 *
 * The browser is needed only for the cookies and the placeId. Contrary to
 * third-party recon notes, the search API is not WAF-blocked server-side
 * (verified 2026-08-02), and the in-page alternative does not work because
 * `browse js` returns empty output for expressions containing `fetch`.
 */
export async function collectEventbrite(): Promise<FetchResult> {
  await browseGoto(BROWSE_URL);
  const html = await browseHtml();
  const placeId = extractPlaceId(html);
  const appVersion = extractAppVersion(html);

  if (!placeId) {
    return {
      source: 'eventbrite',
      records: [],
      termination: { kind: 'error', error: 'could not resolve placeId from __SERVER_DATA__' },
      expectedCount: null,
      pages: 0,
      driftSignals: { placeIdMissing: true, appVersion },
    };
  }

  let cookies: string;
  let csrfToken: string | null;
  try {
    cookies = await readCookieHeader();
    csrfToken = csrfFromCookies(cookies);
  } catch (err) {
    return {
      source: 'eventbrite',
      records: [],
      termination: {
        kind: 'error',
        error: err instanceof Error ? err.message : String(err),
      },
      expectedCount: null,
      pages: 0,
      driftSignals: { placeId, appVersion, csrfMissing: true },
    };
  }

  if (!csrfToken) {
    return {
      source: 'eventbrite',
      records: [],
      termination: { kind: 'error', error: 'csrftoken absent from cookie jar' },
      expectedCount: null,
      pages: 0,
      driftSignals: { placeId, appVersion, csrfMissing: true },
    };
  }

  const result = await fetchEventbrite({
    placeId,
    csrfToken,
    post: cookiePostJson(cookies),
  });

  return {
    ...result,
    driftSignals: { ...result.driftSignals, placeId, appVersion },
  };
}
