import { useEffect } from 'react'

export default function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onDismiss, 7000)
    return () => clearTimeout(t)
  }, [toast, onDismiss])

  if (!toast) return null

  const isSuccess = toast.type === 'success'
  const txUrl = isSuccess && toast.hash
    ? `https://stellar.expert/explorer/testnet/tx/${toast.hash}`
    : null

  return (
    <div
      className={`
        fixed bottom-7 left-1/2 -translate-x-1/2
        min-w-75 max-w-105 w-[90vw]
        flex items-start gap-3
        px-5 py-4 rounded-2xl
        shadow-xl border animate-rise z-50
        
        ${isSuccess
          ? 'bg-card border-green-100'
          : 'bg-card border-red-100'
        }
      `}
    >
      <span className="text-lg mt-0.5 shrink-0">
        {isSuccess ? '✅' : '❌'}
      </span>

      <div className="flex flex-col gap-1 min-w-0">
        <span className="font-bold text-black text-sm">
          {toast.title}
        </span>

        {toast.detail && !txUrl && (
          <span className="text-xs text-black wrap-break-words font-mono">
            {toast.detail}
          </span>
        )}

        {txUrl && (
          <span className="text-xs text-muted font-mono break-all">
            Tx:{' '}
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              {toast.hash.slice(0, 16)}…
            </a>
          </span>
        )}
      </div>

      <button
        onClick={onDismiss}
        className="ml-auto text-muted hover:text-foreground text-lg leading-none shrink-0"
      >
        ×
      </button>
    </div>
  )
}
