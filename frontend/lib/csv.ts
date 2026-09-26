export interface CsvDonation {
  createdAt: string;
  amount: number | string;
  currency: string;
  senderAddress: string;
  transactionHash?: string | null;
  message?: string | null;
}

// A cell starting with one of these is read as a formula by Excel/Sheets, so a
// donor-controlled message like "=HYPERLINK(...)" could execute when opened.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Quotes a value for CSV and neutralizes spreadsheet formula injection. */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const HEADER = ['Date', 'Amount', 'Currency', 'Sender', 'Transaction hash', 'Message'];

/** Builds the CSV text (CRLF line endings) for a donation history export. */
export function donationsToCsv(donations: CsvDonation[]): string {
  const rows = donations.map((d) =>
    [
      d.createdAt,
      d.amount,
      d.currency,
      d.senderAddress,
      d.transactionHash ?? '',
      d.message ?? '',
    ]
      .map(escapeCsvField)
      .join(',')
  );
  return [HEADER.join(','), ...rows].join('\r\n') + '\r\n';
}

export function donationsCsvFilename(username: string, now: Date = new Date()): string {
  const safeName = username.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `supportme-donations-${safeName}-${now.toISOString().slice(0, 10)}.csv`;
}

/** Triggers a browser download. The BOM makes Excel read the file as UTF-8. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
