import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ReceiptPage from '../page';

const params = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => params.current,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const TX_HASH = 'abc123def456';

// ReceiptPage unwraps the `params` prop with React's use(), which suspends
// on an unresolved promise — App Router provides a Suspense boundary in
// production, so tests need to provide one too. The initial render has to be
// wrapped in `act` (and awaited) for React to flush past the suspended commit
// once the (already-resolved) promise settles.
async function renderReceipt(search = '') {
  params.current = new URLSearchParams(search);
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={null}>
        <ReceiptPage params={Promise.resolve({ txHash: TX_HASH })} />
      </Suspense>
    );
  });
  return result;
}

beforeEach(() => {
  params.current = new URLSearchParams();
});

describe('ReceiptPage (#460)', () => {
  it('renders the donation details from the query params', async () => {
    await renderReceipt(
      'amount=25&asset=XLM&creatorName=Maya&creatorUsername=maya&message=Keep+it+up&timestamp=2026-11-19T10:00:00.000Z'
    );

    expect(screen.getByText('25 XLM')).toBeInTheDocument();
    expect(screen.getByText('Maya')).toBeInTheDocument();
    expect(screen.getByText('@maya')).toBeInTheDocument();
    expect(screen.getByText(TX_HASH)).toBeInTheDocument();
    expect(screen.getByText(/Keep it up/)).toBeInTheDocument();
    // The formatted date appears twice: the print-only header and the date section.
    expect(screen.getAllByText(/November 19, 2026/)).toHaveLength(2);
  });

  it('links the transaction hash to the Stellar explorer', async () => {
    await renderReceipt('amount=25');

    const link = screen.getByLabelText('View on Stellar Explorer');
    expect(link.getAttribute('href')).toBe(
      `https://stellar.expert/explorer/testnet/tx/${TX_HASH}`
    );
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('falls back to defaults when no query params are given', async () => {
    await renderReceipt();

    expect(screen.getByText('0 XLM')).toBeInTheDocument();
    expect(screen.getByText('Unknown Creator')).toBeInTheDocument();
    expect(screen.getByText('@unknown')).toBeInTheDocument();
  });

  it('hides the message section when there is no message', async () => {
    await renderReceipt('amount=25&creatorName=Maya');

    expect(screen.queryByText('Message')).not.toBeInTheDocument();
  });

  it('shows Invalid Date for an unparseable timestamp', async () => {
    await renderReceipt('amount=25&timestamp=not-a-date');

    expect(screen.getByText('Invalid Date')).toBeInTheDocument();
  });

  it('calls window.print when the print button is clicked', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    await renderReceipt('amount=25');

    fireEvent.click(screen.getByLabelText('Print receipt'));

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
