// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isE164, maskPhone, normalizeE164 } from '../phone.js';

describe('E.164 normalisation', () => {
  it('accepts the shapes people actually type', () => {
    expect(normalizeE164('+48 500 100 200')).toBe('+48500100200');
    expect(normalizeE164('+48-500-100-200')).toBe('+48500100200');
    expect(normalizeE164('+48 (500) 100.200')).toBe('+48500100200');
    expect(normalizeE164('  +15017122661  ')).toBe('+15017122661');
  });

  it('treats a leading 00 as the international prefix', () => {
    expect(normalizeE164('0048500100200')).toBe('+48500100200');
  });

  it('refuses to guess a country for a bare national number', () => {
    // Assuming a default country is how a text reaches the wrong person.
    expect(normalizeE164('500100200')).toBeNull();
    expect(normalizeE164('0500100200')).toBeNull();
  });

  it('rejects numbers that cannot be E.164', () => {
    expect(normalizeE164('+0500100200')).toBeNull(); // country code cannot start with 0
    expect(normalizeE164('+48123')).toBeNull(); // too short
    expect(normalizeE164('+4812345678901234567')).toBeNull(); // over 15 digits
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164('not a phone')).toBeNull();
    expect(normalizeE164(undefined)).toBeNull();
    expect(normalizeE164(1234567890)).toBeNull();
  });

  it('isE164 agrees with what normalisation produces', () => {
    expect(isE164('+48500100200')).toBe(true);
    expect(isE164('48500100200')).toBe(false);
    expect(isE164('+48 500 100 200')).toBe(false);
  });
});

describe('masking for logs', () => {
  it('keeps only the country code and the last two digits', () => {
    const masked = maskPhone('+48500100200');
    expect(masked.startsWith('+48')).toBe(true);
    expect(masked.endsWith('00')).toBe(true);
    expect(masked).not.toContain('5001002');
  });

  it('never leaks the middle of the number', () => {
    const phone = '+15017122661';
    const masked = maskPhone(phone);
    expect(masked).not.toContain('50171226');
    expect(masked).not.toBe(phone);
  });

  it('refuses to guess when there is nothing to mask', () => {
    expect(maskPhone('')).toBe('<redacted>');
    expect(maskPhone('123')).toBe('<redacted>');
    expect(maskPhone(null)).toBe('<redacted>');
  });
});
