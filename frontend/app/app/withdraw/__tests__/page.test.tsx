import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WithdrawPage from '../page';
import { useAuth } from '@/context/AuthContext';
import { useCreator } from '@/context/CreatorContext';
import { useNgnRate } from '@/lib/useNgnRate';
import { usePrices } from '@/lib/usePrices';
import { notify } from '@/lib/notify';

const { mockLoadAccount, mockNotifySuccess, mockNotifyError } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockNotifySuccess: vi.fn(),
  mockNotifyError: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<any>('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: class MockServer {
        loadAccount = mockLoadAccount;
      },
    },
  };
});

vi.mock('@/lib/notify', () => ({
  notify: {
    success: mockNotifySuccess,
    error: mockNotifyError,
  },
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/context/CreatorContext', () => ({
  useCreator: vi.fn(),
}));

vi.mock('@/lib/useNgnRate', () => ({
  useNgnRate: vi.fn(),
}));

vi.mock('@/lib/usePrices', () => ({
  usePrices: vi.fn(),
}));

vi.mock('@/components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/AppNav', () => ({
  AppNav: () => <nav data-testid="app-nav" />,
}));

const mockUseAuth = vi.mocked(useAuth);
const mockUseCreator = vi.mocked(useCreator);
const mockUseNgnRate = vi.mocked(useNgnRate);
const mockUsePrices = vi.mocked(usePrices);

describe('WithdrawPage - XLM and USDC Cash Out (#154, #164)', () => {
  const MOCK_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const creator = {
    id: 1,
    userId: 42,
    username: 'alice',
    displayName: 'Alice',
    walletAddress: 'GALICE',
    avatarUrl: null,
    donationGoal: null,
    acceptsXlm: true,
    acceptsUsdc: true,
    acceptsUsdt: false,
    socialLinks: null,
    presetAmounts: [],
  };

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_USDC_ISSUER', MOCK_USDC_ISSUER);

    mockUseAuth.mockReturnValue({
      user: { id: 42, walletAddress: 'GALICE' },
      token: 'test-token',
      loading: false,
      loginWithWallet: vi.fn(),
      getTwitterRedirectUrl: vi.fn(),
      completeTwitterLogin: vi.fn(),
      requestMagicLink: vi.fn(),
      verifyMagicLink: vi.fn(),
      logout: vi.fn(),
    });

    mockUseCreator.mockReturnValue({
      creator,
      loading: false,
      invalidate: vi.fn(),
    });

    mockUseNgnRate.mockReturnValue({
      rate: 1380,
      xlmRate: 165,
      source: 'coingecko',
      timestamp: Date.now(),
      loading: false,
      isStale: false,
      ageMinutes: 0,
    });

    (mockUsePrices as any).mockReturnValue({
      XLM: 0.12,
      USDC: 1.0,
    });

    mockLoadAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '500.0000000' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: MOCK_USDC_ISSUER, balance: '25.0000000' },
      ],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/api/verify-account')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ accountName: 'Jane Doe' }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        });
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the prominent demo mode disclaimer above the fold', () => {
    render(<WithdrawPage />);

    expect(screen.getByText(/Demo mode/i)).toBeInTheDocument();
    expect(screen.getByText(/Simulated off-ramp/i)).toBeInTheDocument();
    expect(
      screen.getByText(/No real bank transfer occurs and no on-chain funds move/i)
    ).toBeInTheDocument();
  });

  it('defaults to XLM cash-out for a creator holding XLM, displaying balance and direct cash-out notice', async () => {
    render(<WithdrawPage />);

    await waitFor(() => {
      expect(screen.getByText('500')).toBeInTheDocument();
      expect(screen.getByText('25')).toBeInTheDocument();
    });

    expect(screen.getByText(/Direct XLM cash-out enabled/i)).toBeInTheDocument();
    expect(screen.getByText(/Your XLM will be converted directly to Naira/i)).toBeInTheDocument();
    expect(screen.getByText('Swap XLM to USDC')).toBeInTheDocument();

    const xlmRadio = screen.getByRole('radio', { name: /xlm/i });
    expect(xlmRadio).toHaveAttribute('aria-checked', 'true');
  });

  it('allows switching between XLM and USDC cash-out', async () => {
    render(<WithdrawPage />);

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /xlm/i })).toBeInTheDocument();
    });

    const usdcRadio = screen.getByRole('radio', { name: /usdc/i });
    fireEvent.click(usdcRadio);

    expect(usdcRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Direct USDC cash-out enabled/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Amount \(USDC\)/i)).toBeInTheDocument();
  });

  it('updates estimated Naira amount based on entered XLM amount and XLM rate', async () => {
    render(<WithdrawPage />);

    await waitFor(() => {
      expect(screen.getByText('500')).toBeInTheDocument();
    });

    const amtInput = screen.getByLabelText(/Amount \(XLM\)/i);
    fireEvent.change(amtInput, { target: { value: '100' } });

    // 100 * 165 = 16,500
    await waitFor(() => {
      expect(screen.getByText(/₦16,500/)).toBeInTheDocument();
      expect(screen.getByText(/₦165\/XLM/)).toBeInTheDocument();
    });
  });

  it('supports Max button to fill full available balance for selected asset', async () => {
    render(<WithdrawPage />);

    await waitFor(() => {
      expect(screen.getByText('500')).toBeInTheDocument();
    });

    const maxButton = screen.getByRole('button', { name: /Max \(500 XLM\)/i });
    fireEvent.click(maxButton);

    const amtInput = screen.getByLabelText(/Amount \(XLM\)/i) as HTMLInputElement;
    expect(amtInput.value).toBe('500');

    // 500 * 165 = 82,500
    expect(screen.getByText(/₦82,500/)).toBeInTheDocument();
  });

  it('validates insufficient balance and displays clear error', async () => {
    render(<WithdrawPage />);

    await waitFor(() => {
      expect(screen.getByText('500')).toBeInTheDocument();
    });

    const amtInput = screen.getByLabelText(/Amount \(XLM\)/i);
    fireEvent.change(amtInput, { target: { value: '600' } });

    const submitBtn = screen.getByRole('button', { name: /Simulate withdrawal/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Amount exceeds your available XLM balance.')).toBeInTheDocument();
    });
  });

  it('verifies bank account number and displays account holder name', async () => {
    vi.mocked(fetch).mockImplementation((input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/verify-account')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ accountName: 'ALICE JANE DOE' }),
        } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    });

    render(<WithdrawPage />);

    fireEvent.change(screen.getByLabelText(/Bank/i), { target: { value: 'GTBank' } });
    fireEvent.change(screen.getByLabelText(/Account number/i), { target: { value: '0123456789' } });

    await waitFor(() => {
      expect(screen.getByText(/Account holder: ALICE JANE DOE/i)).toBeInTheDocument();
    });
  });

  it('shows required creator profile warning when user has no creator profile', () => {
    mockUseCreator.mockReturnValue({
      creator: null,
      loading: false,
      invalidate: vi.fn(),
    });

    render(<WithdrawPage />);

    expect(screen.getByText('Creator profile required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Simulate withdrawal/i })).toBeDisabled();
  });

  it('submits withdrawal successfully, calls POST /api/withdrawals, and displays reference', async () => {
    vi.mocked(fetch).mockImplementation((input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/verify-account')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ accountName: 'Jane Doe' }),
        } as Response);
      }
      if (url.includes('/api/withdrawals')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            id: 10,
            creatorUsername: 'alice',
            amountIn: 50,
            amountOut: 8250,
            fee: 0,
            currency: 'XLM',
            anchorTxId: 'PL-TESTREF123',
            status: 'completed',
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    });

    render(<WithdrawPage />);

    fireEvent.change(screen.getByLabelText(/Amount \(XLM\)/i), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/Bank/i), { target: { value: 'Access Bank' } });
    fireEvent.change(screen.getByLabelText(/Account number/i), { target: { value: '0123456789' } });

    await waitFor(() => {
      expect(screen.getByText(/Account holder: Jane Doe/i)).toBeInTheDocument();
    });

    const submitBtn = screen.getByRole('button', { name: /Simulate withdrawal/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Withdrawal recorded (Demo)')).toBeInTheDocument();
      expect(screen.getByText('PL-TESTREF123')).toBeInTheDocument();
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/withdrawals'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        }),
        body: expect.stringContaining('"creatorUsername":"alice"'),
      })
    );

    expect(mockNotifySuccess).toHaveBeenCalledWith('Withdrawal recorded (demo)');
    expect(screen.getByRole('link', { name: /View in Dashboard/i })).toHaveAttribute(
      'href',
      '/dashboard'
    );
  });

  it('opens in-app swap modal when clicking Swap XLM to USDC', async () => {
    render(<WithdrawPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Swap XLM to USDC' })).toBeInTheDocument();
    });

    const swapBtn = screen.getByRole('button', { name: 'Swap XLM to USDC' });
    fireEvent.click(swapBtn);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Convert XLM → USDC' })).toBeInTheDocument();
    });
  });
});
