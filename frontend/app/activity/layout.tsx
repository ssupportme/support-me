import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Activity | SupportMe',
  robots: {
    index: false,
    follow: false,
  },
};

export default function ActivityLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
