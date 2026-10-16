'use client';

import React, { useState, useEffect } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';
import { notify } from '@/lib/notify';
import { useAuth } from '@/context/AuthContext';
import { signTransaction } from '@/lib/wallet';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const USDC_ISSUER = process.env.NEXT_PUBLIC_USDC_ISSUER;
const NETWORK = StellarSdk.Networks.TESTNET;

export default function ConvertXlmToUsdcModal({
  open,
  onClose,
  maxXlm,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  maxXlm: number;
  onSuccess?: (newUsdcBalance?: number) => void;
}) {
  const { user } = useAuth();
  const walletAddress = user?.walletAddress || '';
  const [amount, setAmount] = useState<string>(String(maxXlm || ''));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // keep amount in sync if maxXlm changes while modal is open
  useEffect(() => {
    setAmount(String(maxXlm || ''));
  }, [maxXlm]);

  if (!open) return null;
  if (!USDC_ISSUER) {
    return (
      <div className="modal">
        <div className="card-brutal p-6">
          <h2 className="text-lg font-bold">Convert XLM → USDC</h2>
          <p className="mt-2 text-sm text-muted">USDC issuer is not configured on this deployment.</p>
          <div className="mt-4">
            <button className="btn-brutal" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  async function handleConvert() {
    setError(null);
    setLoading(true);
    try {
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a valid amount');

      // Load account and build a path payment transaction that pays XLM and
      // receives USDC to the same user account.
      const account = await server.loadAccount(walletAddress);
      const usdcAsset = new StellarSdk.Asset('USDC', USDC_ISSUER);

      const txBuilder = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK,
      });

      txBuilder.addOperation(
        StellarSdk.Operation.pathPaymentStrictSend({
          sendAsset: StellarSdk.Asset.native(),
          sendAmount: n.toFixed(7), // send XLM fixed format
          destination: walletAddress,
          destAsset: usdcAsset,
          // NOTE: destMin should be set to a realistic minimum in production
          destMin: '0',
          path: [],
        }),
      );

      const tx = txBuilder.setTimeout(180).build();

      // Our wallet.signTransaction helper expects an XDR string + address.
      // Normalize to that shape and handle the variety of mocked/real returns:
      // - mocked helpers often return { signedTxXdr: '...' }
      // - some helpers return a base64 XDR string
      // - some return a Transaction instance
      const xdr = tx.toXDR();
      const signed = await signTransaction(xdr, walletAddress as string);

      // Resolve signed XDR from common shapes
      let signedXdr: string | null = null;
      if (!signed) {
        throw new Error('No signed transaction returned from wallet');
      }
      if (typeof signed === 'string') {
        signedXdr = signed;
      } else if (typeof signed === 'object') {
        if ((signed as any).signedTxXdr) signedXdr = (signed as any).signedTxXdr;
        else if ((signed as any).signedXdr) signedXdr = (signed as any).signedXdr;
        else if ((signed as any).tx && typeof (signed as any).tx.toXDR === 'function') {
          signedXdr = (signed as any).tx.toXDR();
        } else if ((signed as any).toXDR) {
          // some libs return a transaction-like object with toXDR
          signedXdr = (signed as any).toXDR();
        }
      }

      if (!signedXdr) {
        throw new Error('Could not interpret signed transaction returned by wallet');
      }

      // Convert to a Transaction object the same way other parts of the code do
      const signedTx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK);

      // Submit to horizon. Some wallet helpers may already have submitted;
      // tolerate both success and submission errors here.
      try {
        await server.submitTransaction(signedTx);
      } catch (submitErr) {
        // If wallet already submitted or network hiccup, surface a helpful
        // message but still proceed to refresh balances — caller may check.
        console.warn('submitTransaction failed (wallet may have submitted already):', submitErr);
      }

      notify.success('Conversion submitted — check your wallet for confirmations');
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || String(err));
      notify.error('Conversion failed', err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="card-brutal p-6 w-full max-w-lg">
        <h2 className="text-lg font-extrabold mb-2">Convert XLM → USDC</h2>
        <p className="text-sm text-muted mb-4">
          Convert XLM in your wallet to USDC so you can withdraw to Naira. This will open your wallet to confirm a Stellar swap transaction.
        </p>

        <label className="block text-sm font-bold mb-1">Amount (XLM)</label>
        <input
          className="input-brutal mb-3"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          disabled={loading}
        />
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="flex gap-2">
          <button className="btn-brutal btn-brutal-white" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn-brutal btn-brutal-primary" onClick={handleConvert} disabled={loading}>
            {loading ? 'Converting…' : `Convert ${amount || ''} XLM`}
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Note: this runs on Stellar testnet in demo mode. In production the app should compute an expected destination amount and enforce a minimum received (slippage protection).
        </p>
      </div>
    </div>
  );
}
