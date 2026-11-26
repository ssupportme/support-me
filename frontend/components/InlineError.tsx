interface InlineErrorProps {
  message: string;
  onRetry: () => void;
  /** Extra classes for the banner container (colour, spacing, border). */
  className?: string;
  /** Smaller retry button, for errors shown inside a list. */
  compact?: boolean;
}

// An error banner with a Retry action, so a failed load can be re-attempted
// in place instead of leaving the user on a dead end (#554).
export function InlineError({ message, onRetry, className = '', compact = false }: InlineErrorProps) {
  const buttonSize = compact ? 'px-3 py-1 text-xs' : 'px-4 py-2 text-sm';

  return (
    <div role="alert" className={`flex items-center justify-between gap-3 ${className}`.trim()}>
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className={`shrink-0 bg-ink text-white font-bold rounded hover:opacity-90 transition-opacity ${buttonSize}`}
      >
        Retry
      </button>
    </div>
  );
}
