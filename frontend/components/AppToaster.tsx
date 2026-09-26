'use client';

import { Toaster } from 'sonner';
import { useTheme } from '@/context/ThemeContext';

// The app's single toast outlet, mounted once in the root layout. Fire toasts
// through `notify` (lib/notify.ts) so success/error feedback looks and behaves
// the same everywhere.
//
// Accessibility (via sonner): toasts render in an aria-live="polite" region
// labelled "Notifications", so screen readers announce them; Alt+T moves
// keyboard focus to the toasts, and every toast has a labelled close button.
// Hovering or focusing the region pauses auto-dismiss.
export function AppToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={resolvedTheme}
      position="bottom-center"
      richColors
      closeButton
      duration={5000}
      hotkey={['altKey', 'KeyT']}
      containerAriaLabel="Notifications"
      toastOptions={{ closeButtonAriaLabel: 'Dismiss notification' }}
    />
  );
}
