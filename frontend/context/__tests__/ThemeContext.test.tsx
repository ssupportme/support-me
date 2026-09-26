import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '@/context/ThemeContext';

const STORAGE_KEY = 'supportme-theme';

function mockSystemTheme(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('dark') && dark,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
}

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    mockSystemTheme(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
  });

  it('follows the system preference by default', async () => {
    mockSystemTheme(true);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    await waitFor(() => expect(result.current.resolvedTheme).toBe('dark'));
    expect(result.current.theme).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('defaults to light when the system is light', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    await waitFor(() => expect(result.current.resolvedTheme).toBe('light'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('applies an explicit choice, persists it, and toggles the root class', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    await waitFor(() => expect(result.current.theme).toBe('system'));

    act(() => {
      result.current.setTheme('dark');
    });

    expect(result.current.theme).toBe('dark');
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');

    act(() => {
      result.current.setTheme('light');
    });

    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('restores a stored preference on mount', async () => {
    localStorage.setItem(STORAGE_KEY, 'dark');

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    await waitFor(() => expect(result.current.resolvedTheme).toBe('dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
