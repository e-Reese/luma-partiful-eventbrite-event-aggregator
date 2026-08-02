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

describe('extractServerData', () => {
  it('parses the embedded first page of results', () => {
    const data = extractServerData(HTML);
    expect(data?.search_data?.events?.results?.[0]?.id).toBe('1');
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
