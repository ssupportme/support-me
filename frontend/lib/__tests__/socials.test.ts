import { describe, expect, it } from 'vitest';
import { isHttpUrl, normalizeSocialValue, SOCIAL_PLATFORMS } from '@/lib/socials';

describe('social URL validation', () => {
  it.each(['https://example.com', 'http://example.com/path'])('accepts %s', (value) => {
    expect(isHttpUrl(value)).toBe(true);
  });
  it.each(['javascript:alert(1)', 'data:text/html,hello', 'my site', 'https://'])('rejects %s', (value) => {
    expect(isHttpUrl(value)).toBe(false);
  });

  it.each([
    ['twitter', 'alice', 'https://x.com/alice'],
    ['twitter', '@alice', 'https://x.com/alice'],
    ['instagram', 'alice', 'https://instagram.com/alice'],
    ['instagram', '@alice', 'https://instagram.com/alice'],
    ['youtube', 'mychannel', 'https://www.youtube.com/@mychannel'],
    ['youtube', '@mychannel', 'https://www.youtube.com/@mychannel'],
    ['tiktok', 'myuser', 'https://www.tiktok.com/@myuser'],
    ['tiktok', '@myuser', 'https://www.tiktok.com/@myuser'],
    ['github', 'alice', 'https://github.com/alice'],
    ['github', '@alice', 'https://github.com/alice'],
    ['linkedin', 'in/alice', 'https://linkedin.com/in/alice'],
    ['linkedin', '@in/alice', 'https://linkedin.com/in/alice'],
    ['telegram', 'alice', 'https://t.me/alice'],
    ['telegram', '@alice', 'https://t.me/alice'],
    ['website', 'example.com', 'https://example.com'],
    ['website', '@example.com', 'https://@example.com'],
  ])('normalizes %s handle %s to %s', (key, raw, expected) => {
    const platform = SOCIAL_PLATFORMS.find((item) => item.key === key)!;
    expect(normalizeSocialValue(platform, raw)).toBe(expected);
  });

  it.each(SOCIAL_PLATFORMS)('keeps pasted URLs as-is for %s', (platform) => {
    const value = platform.key === 'website' ? 'https://example.com' : `https://${platform.key}.example.com/user`;
    expect(normalizeSocialValue(platform, value)).toBe(value);
  });

  it.each(SOCIAL_PLATFORMS)('returns empty for blank input on %s', (platform) => {
    expect(normalizeSocialValue(platform, '   ')).toBe('');
  });
});
