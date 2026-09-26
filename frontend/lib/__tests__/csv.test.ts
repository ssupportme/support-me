import { describe, it, expect } from 'vitest';
import { donationsToCsv, donationsCsvFilename, escapeCsvField } from '@/lib/csv';

describe('escapeCsvField', () => {
  it('leaves plain values untouched and blanks null/undefined', () => {
    expect(escapeCsvField('hello')).toBe('hello');
    expect(escapeCsvField(12.5)).toBe('12.5');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('quotes fields containing commas, quotes or newlines and doubles inner quotes', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralizes spreadsheet formula injection in text fields', () => {
    expect(escapeCsvField('=HYPERLINK("http://evil","x")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""x"")"'
    );
    expect(escapeCsvField('+1+1')).toBe("'+1+1");
    expect(escapeCsvField('-2')).toBe("'-2");
    expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
  });
});

describe('donationsToCsv', () => {
  it('writes a header row and one row per donation with CRLF line endings', () => {
    const csv = donationsToCsv([
      {
        createdAt: '2026-09-01T10:00:00.000Z',
        amount: 25.5,
        currency: 'XLM',
        senderAddress: 'GABC',
        transactionHash: 'abc123',
        message: 'Keep it up, friend',
      },
      {
        createdAt: '2026-09-02T10:00:00.000Z',
        amount: 5,
        currency: 'USDC',
        senderAddress: 'GDEF',
        transactionHash: null,
        message: null,
      },
    ]);

    expect(csv.split('\r\n')).toEqual([
      'Date,Amount,Currency,Sender,Transaction hash,Message',
      '2026-09-01T10:00:00.000Z,25.5,XLM,GABC,abc123,"Keep it up, friend"',
      '2026-09-02T10:00:00.000Z,5,USDC,GDEF,,',
      '',
    ]);
  });

  it('produces just the header for an empty history', () => {
    expect(donationsToCsv([])).toBe('Date,Amount,Currency,Sender,Transaction hash,Message\r\n');
  });

  it('keeps non-ASCII messages intact', () => {
    const csv = donationsToCsv([
      { createdAt: 'd', amount: 1, currency: 'XLM', senderAddress: 'G', message: 'Ẹ ṣé ❤️' },
    ]);
    expect(csv).toContain('Ẹ ṣé ❤️');
  });
});

describe('donationsCsvFilename', () => {
  it('includes the username and the date, and strips unsafe characters', () => {
    const name = donationsCsvFilename('al/ice..', new Date('2026-09-26T12:00:00Z'));
    expect(name).toBe('supportme-donations-al_ice__-2026-09-26.csv');
  });
});
