'use client';

import { useTranslations } from 'next-intl';
import { LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';

interface LanguageSwitcherProps {
  locale: Locale;
  onChange: (locale: Locale) => void;
  className?: string;
}

/**
 * Lets the viewer pick which language the page's translated strings render
 * in. Purely client-side: the caller owns the active locale (see
 * `useLocalePreference` in `lib/i18n.ts`) and this just renders the picker.
 * Language names are shown in their own language (not translated) — the
 * usual convention for a language switcher.
 */
export function LanguageSwitcher({ locale, onChange, className }: LanguageSwitcherProps) {
  const t = useTranslations('languageSwitcher');

  return (
    <label className={`inline-flex items-center gap-1.5 text-sm font-bold text-ink ${className ?? ''}`}>
      <span className="sr-only">{t('label')}</span>
      <select
        value={locale}
        onChange={(e) => onChange(e.target.value as Locale)}
        aria-label={t('label')}
        className="input-brutal text-sm py-1.5 w-auto"
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code}>
            {LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
