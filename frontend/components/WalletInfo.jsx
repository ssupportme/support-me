export default function WalletInfo({ address, balance }) {
  const short = address
    ? address.slice(0, 6) + '…' + address.slice(-4)
    : '—'

  return (
    <div className="bg-card border border-border rounded-2xl px-4 py-3 flex flex-col gap-2 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-black">
          Address
        </span>
        <span className="font-mono text-[13px] text-muted">{short}</span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-black">
          Balance
        </span>
        <span className="bg-accent-bg text-primary rounded-full px-3 py-0.5 text-[13px] font-semibold font-mono whitespace-nowrap">
          {balance !== null ? `${balance} XLM` : 'Loading…'}
        </span>
      </div>
    </div>
  )
}
