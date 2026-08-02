import { describe, it, expect } from 'vitest';
import {
  extractAppVersion, extractPlaceId, extractServerData,
} from '../../../src/sources/eventbrite/browse.js';

const HTML = `<html><script>window.__SERVER_DATA__ = {"placeId":"85922583",
"app_version":"10.14.65",
"search_data":{"events":{"results":[{"id":"1","name":"Blues Night"}]}}};</script></html>`;

describe('extractPlaceId', () => {
  it('pulls the internal place id from __SERVER_DATA__', () => {
    expect(extractPlaceId(HTML)).toBe('85922583');
  });

  it('returns null when the marker is absent', () => {
    expect(extractPlaceId('<html></html>')).toBeNull();
  });
});

// The shape the live site actually serves: more than one global assigned inside
// a single script block. The original regex matched lazily up to `</script>`,
// ran past the real object boundary into the second assignment, and returned
// null on every real page while passing against HTML above.
const REAL_SHAPE_HTML = `<html><script>
window.__SERVER_DATA__ = {"placeId":"85922583","app_version":"10.14.68",
"search_data":{"events":{"results":[{"id":"42","name":"Rooftop {Party}"}]}}};
window.__REACT_QUERY_STATE__ = {"queries":[{"state":{"data":{"nested":{"deep":true}}}}]};
window.__SOMETHING_ELSE__ = {"a":1};
</script></html>`;

describe('extractServerData', () => {
  it('parses the embedded first page of results', () => {
    const data = extractServerData(HTML);
    expect(data?.search_data?.events?.results?.[0]?.id).toBe('1');
  });

  it('stops at the real object boundary when other globals follow in the same script', () => {
    const data = extractServerData(REAL_SHAPE_HTML);
    expect(data?.placeId).toBe('85922583');
    expect(data?.search_data?.events?.results?.[0]?.id).toBe('42');
  });

  it('is not confused by braces inside quoted strings', () => {
    const data = extractServerData(REAL_SHAPE_HTML);
    expect(data?.search_data?.events?.results?.[0]?.name).toBe('Rooftop {Party}');
  });

  it('returns null when the marker is absent', () => {
    expect(extractServerData('<html></html>')).toBeNull();
  });
});

describe('extractAppVersion', () => {
  it('captures the discover app version as a drift signal', () => {
    expect(extractAppVersion(HTML)).toBe('10.14.65');
  });

  it('returns null when the version is absent', () => {
    expect(extractAppVersion('<html></html>')).toBeNull();
  });
});
