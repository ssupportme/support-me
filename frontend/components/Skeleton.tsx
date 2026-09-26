import { HTMLAttributes } from 'react';

export function Skeleton({ className = '', style, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`animate-pulse rounded-md border-2 border-ink/10 bg-ink/10 ${className}`}
      style={style}
      {...rest}
    />
  );
}
