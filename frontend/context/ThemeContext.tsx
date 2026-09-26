'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextType {
  /** The user's stored preference; 'system' means follow the OS. */
  theme: Theme;
  /** The theme actually applied to the document. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = 'supportme-theme';

const SYSTEM_QUERY = '(prefers-color-scheme: dark)';

// Default value keeps components that render outside the provider (tests,
// isolated component stories) working rather than throwing like useAuth does.
const ThemeContext = createContext<ThemeContextType>({
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => {},
});

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function systemTheme(): ResolvedTheme {
  return typeof window !== 'undefined' && window.matchMedia(SYSTEM_QUERY).matches
    ? 'dark'
    : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system');
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light');

  // Hydrate from localStorage after mount. The pre-paint script in the root
  // layout has already applied the right class, so there's no flash and no
  // server/client markup mismatch to worry about.
  useEffect(() => {
    const initial = readStoredTheme();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional hydration gate: first client render must match the server HTML (the pre-paint script, not React, owns the initial class).
    setThemeState(initial);
    setResolvedTheme(initial === 'system' ? systemTheme() : initial);
  }, []);

  // Reflect the resolved theme on <html> and follow OS changes while in
  // 'system' mode.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.style.colorScheme = resolvedTheme;

    if (theme !== 'system') return;
    const media = window.matchMedia(SYSTEM_QUERY);
    const onChange = () => setResolvedTheme(systemTheme());
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme, resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
    setResolvedTheme(next === 'system' ? systemTheme() : next);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
