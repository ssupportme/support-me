"use client"

import { useState, useCallback } from 'react'
import * as StellarSdk from '@stellar/stellar-sdk'
import {
  checkConnection,
  getRequestAccess,
  retrievePublicKey,
  getBalance,
  userSignTransaction,
} from '../lib/freighter'
import WalletInfo  from '../components/WalletInfo'
import DonationForm from '../components/DonationForm'
import Toast        from '../components/Toast'


const RECIPIENT   = 'GDFK3RBPTGAEYLTVUDCSBGSPFKVFUVZKDMN7KJ5VSLK2QQJQME3P3LJQ'
const HORIZON_URL = 'https://horizon-testnet.stellar.org'
const server      = new StellarSdk.Horizon.Server(HORIZON_URL)


export default function App() {
  const [address,   setAddress]   = useState(null)
  const [balance,   setBalance]   = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [sending,    setSending]    = useState(false)
  const [toast,      setToast]      = useState(null)

const showToast = (type, title, detail = '', hash = '') =>
  setToast({ type, title, detail, hash });

//Connect wallet
  const handleConnect = async () => {
    setConnecting(true)
    try {
      await checkConnection()
      await getRequestAccess()
      const pub = await retrievePublicKey()
      setAddress(pub)

      // fetch balance
      const bal = await getBalance()
      setBalance(parseFloat(bal).toFixed(4))
    } catch (err) {
      showToast('error', 'Connection failed', err?.message || 'Freighter not unlocked or not installed.')
    } finally {
      setConnecting(false)
    }
  }

//discpnnnect wallet
  const handleDisconnect = () => {
    setAddress(null)
    setBalance(null)
  }

//send some xlm to the creator
  const handleSend = useCallback(async ({ amount, memo }) => {
    setSending(true)
    try {
      const account = await server.loadAccount(address)

      const builder = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: RECIPIENT,
            asset:       StellarSdk.Asset.native(),
            amount:      parseFloat(amount).toFixed(7),
          })
        )
        .setTimeout(180)

      if (memo?.trim()) {
        builder.addMemo(StellarSdk.Memo.text(memo.trim()))
      }

      const tx  = builder.build()
      const xdr = tx.toXDR()

      // Sign via Freighter (uses our helper which wraps signTransaction)
      const { signedTxXdr } = await userSignTransaction(xdr, address)

      // Submit
      const signed = StellarSdk.TransactionBuilder.fromXDR(
        signedTxXdr,
        StellarSdk.Networks.TESTNET,
      )
      const result = await server.submitTransaction(signed)

      // Refresh balance
      try {
        const newBal = await getBalance()
        setBalance(parseFloat(newBal).toFixed(4))
      } catch { /* non-fatal */ }

      showToast('success', 'Donation sent! 🎉', '', result.hash)
    } catch (err) {
      const msg =
        err?.response?.data?.extras?.result_codes?.transaction ||
        err?.message ||
        'Transaction failed. Please try again.'
      showToast('error', 'Transaction failed', msg)
    } finally {
      setSending(false)
    }
  }, [address])


  return (
    <div className="relative min-h-screen bg-white flex flex-col items-center justify-center px-5 py-10 overflow-hidden">

      {/* Grid background */}
      <div className="grid-bg absolute inset-0 opacity-40 pointer-events-none" />

      {/* Glow blob */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: '-160px', left: '50%',
          transform: 'translateX(-50%)',
          width: '700px', height: '420px',
          background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.18) 0%, transparent 70%)',
        }}
      />

      {/* Card */}
      <div className="relative z-10 w-full max-w-115 bg-white border border-border rounded-[22px] shadow-[0_1px_3px_rgba(0,0,0,0.06),_0_4px_16px_rgba(99,102,241,0.08)] overflow-hidden animate-rise">

        {/* Header */}
        <div className="bg-card border-b border-border px-9 py-8 text-center">
          <div className="w-16 h-16 rounded-full bg-accent-bg border-2 border-border flex items-center justify-center text-3xl mx-auto mb-4">
            ☕
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-black/80">
            Support Me
          </h1>
          <p className="mt-1.5 text-sm text-muted leading-relaxed">
            If my work has helped you, send a little XLM my way.
            <br />It means the world. Thank you. 🙏
          </p>
        </div>

        {/* Body */}
        <div className="px-9 py-7 flex flex-col gap-5">

          {/* No Freighter warning */}
          {typeof window !== 'undefined' && !window.freighterApi && !address && (
            <div className="flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 text-sm text-orange-800 leading-relaxed">
              <span className="hrink-0">⚠️</span>
              <span>
                Freighter not detected.{' '}
                <a
                  href="https://freighter.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-violet-700 hover:underline"
                >
                  Install Freighter
                </a>{' '}
                and reload.
              </span>
            </div>
          )}

          {/* Connect button */}
          {!address ? (
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="
                w-full py-3.5 rounded-xl
                flex items-center justify-center gap-2
                font-semibold text-[15px] text-white
                bg-accent hover:bg-accent-dim
                border border-accent
                disabled:opacity-60 disabled:cursor-not-allowed
                transition-all active:scale-[.98]
                bg-[#6366F1] hover:bg-[#4F46E5] cursor-pointer
              "
            >
              {connecting ? (
                <>
                  <span className="spinner" />
                  <span>Connecting…</span>
                </>
              ) : (
                <>
                  <span>Connect Wallet</span>
                </>
              )}
            </button>
          ) : (
            <>
              {/* Wallet address and balance */}
              <WalletInfo address={address} balance={balance} />

              {/* Donation form */}
              <DonationForm onSend={handleSend} loading={sending} />

              {/* Wallet Disconnect */}
              <button
                onClick={handleDisconnect}
                className="text-[12px] text-muted hover:text-error underline underline-offset-2 text-center transition-colors cursor-pointer"
              >
                Disconnect wallet
              </button>
            </>
          )}

        </div>
      </div>

      {/* Footer */}
      <p className="relative z-10 mt-6 text-[12px]  text-center text-black/60">
        Powered by <span className=" font-semibold">Stellar Testnet</span> · Freighter Wallet
      </p>

      {/* Toast */}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
