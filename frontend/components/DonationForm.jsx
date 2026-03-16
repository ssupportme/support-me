import { useState } from 'react'

export default function DonationForm({ onSend, loading }) {
  const [amount, setAmount] = useState('')
  const [memo, setMemo]     = useState('')

  const valid = parseFloat(amount) > 0

  const handleSend = () => {
    if (!valid) return
    onSend({ amount, memo })
  }

  return (
    <div className="flex flex-col gap-4 animate-fade-in">

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted">
          Send a donation
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Amount */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="amount"
          className="text-[12px] font-semibold text-muted"
        >
          Amount
        </label>
        <div className="relative">
          <input
            id="amount"
            type="number"
            min="0.0000001"
            step="any"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.00"
            className="
              w-full pr-14 pl-4 py-3.5
              border border-border rounded-xl
              font-sans text-[15px] font-medium
              bg-none outline-none
              text-black
              placeholder:text-muted
              focus:border-primary focus:ring-2 focus:ring-primary/10
              transition
            "
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-bold font-mono text-primary pointer-events-none">
            XLM
          </span>
        </div>
      </div>

      {/* Memo */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="memo"
          className="text-[12px] font-semibold text-muted"
        >
          Message{' '}
          <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="memo"
          type="text"
          maxLength={28}
          value={memo}
          onChange={e => setMemo(e.target.value)}
          placeholder="Add a kind note…"
          className="
            w-full px-4 py-3.5
            border border-border rounded-xl
            font-sans text-[15px] text-black
            bg-none outline-none
            placeholder:text-muted
            focus:border-primary focus:ring-2 focus:ring-primary/10
            transition
          "
        />
      </div>

      {/* Send button */}
      <button
        onClick={handleSend}
        disabled={!valid || loading}
        className="
          w-full py-4 rounded-xl
          flex items-center justify-center gap-2
          cursor-pointer
          font-bold text-[15px] text-white
          bg-primary hover:bg-primary-dim
          shadow-[0_2px_12px_rgba(99,102,241,0.28)]
          hover:shadow-[0_4px_20px_rgba(99,102,241,0.36)]
          disabled:bg-foreground disabled:text-muted disabled:shadow-none disabled:cursor-not-allowed
          transition-all active:scale-[.98]
        "
      >
        {loading ? (
          <>
            <span className="spinner" />
            <span>Sending…</span>
          </>
        ) : (
          <span>💜 Send Donation</span>
        )}
      </button>

    </div>
  )
}
