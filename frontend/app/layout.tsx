import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { AppToaster } from "@/components/AppToaster";
import { OfflineBanner } from "@/components/OfflineBanner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
});

const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://support-mee.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(baseUrl),
  title: {
    default: "SupportMe — Direct Tipping Platform Built on Stellar",
    template: "%s | SupportMe",
  },
  description: "Support your favorite creators directly with XLM and USDC on Stellar. Zero platform fees and instant bank cashout.",
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#161412" },
    { color: "#ffd84d" },
  ],
};

// Applied to <html> before first paint so the stored/system theme is in place
// before React hydrates (no flash of the wrong theme). Mirrors the logic in
// context/ThemeContext.tsx — keep the two in sync.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('supportme-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(_){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} antialiased`}
      >
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <OfflineBanner />
        <ThemeProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
          <AppToaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
