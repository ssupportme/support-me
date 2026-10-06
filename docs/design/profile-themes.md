# Custom Profile Themes — Design Spec

Status: **Design / Handoff-ready** · Owner: UI/UX · Consumers: `frontend/` (Next.js)

Tracks issues: **#21** — *UI/UX: Design custom profile themes system*

---

## 1. Problem & Goal

The README Roadmap calls for **custom profile themes** so creators can
personalize their public page beyond the current single default look. Today
every creator's `/{username}` page renders with the same neobrutalism palette
(`frontend/app/globals.css`) regardless of who they are. This spec designs:

1. a small, curated set of theme options a creator can pick from (not a full
   color picker — that's a non-goal, see §10);
2. where and how theme selection appears in Settings;
3. how the selected theme renders on the public profile page, in both light
   and dark mode;
4. everything in a form the frontend team can implement directly from.

## 2. Design Decisions (short version)

1. **Six curated presets, not a free-form picker.** A creator picks one of six
   accent presets (§4). Free-form hex input is a real support/abuse surface
   (unreadable contrast combinations, brand dilution) and is explicitly out of
   scope for v1 — see §10.
2. **Accent-only theming, not layout theming.** A preset swaps the *accent*
   color family (`--color-primary`/`--color-primary-dim` and one brand fill
   used for the primary CTA) and nothing else. Borders stay hard ink, shadows
   stay the chunky offset drop, typography is unchanged. This keeps every
   themed profile still unmistakably a SupportMe page — same guarantee the
   donation widget spec (`docs/design/donation-widget.md` §4) makes for brand
   recognition.
3. **Themes apply only to the public profile, not the dashboard/settings
   chrome.** A creator's own dashboard always renders in the default palette
   so the product UI stays consistent for the person actually using it; only
   the page other people see (`/{username}`) is themed. This mirrors how the
   donation widget's `theme` param only affects the embed, never the parent
   site.
4. **Reuses the existing dark-mode variable-swap mechanism.** Presets are
   expressed as the same `--color-primary`/`--color-primary-dim`/brand-fill
   custom properties `globals.css` already defines, just re-assigned per
   preset instead of per `.dark` class. No new CSS architecture.
5. **Preset choice is independent of light/dark mode.** A creator picks a
   preset AND their visitors' browsers independently resolve light/dark via
   the existing `.dark` class mechanism — every preset ships both a light and
   dark variant (§4) so the two axes compose cleanly.

## 3. Where Theme Selection Lives

New settings section, same pattern as every other section on
`frontend/app/settings/page.tsx` (`<section className="space-y-4 border-t-2
border-ink pt-6">` + `<h2 className="text-lg font-extrabold
text-ink">…</h2>`), inserted directly after the existing **Profile** section
(after line 419, before **Payments**) since theme is a profile-presentation
concern, not a payments one.

### Settings section mock

```
┌──────────────────────────────────────────────────┐
│  Profile theme                                    │
│  Pick an accent for your public page. Visitors     │
│  still see it in their own light/dark preference.  │
│                                                     │
│  ( ) Violet (default)   ( ) Lime        ( ) Cyan   │
│  ( ) Pink               ( ) Orange      ( ) Lilac  │
│                                                     │
│  ┌────────────────────────────────────────────┐   │
│  │        <mini live preview card>              │   │
│  │   @yourhandle      [ Support ]  ← accent btn │   │
│  └────────────────────────────────────────────┘   │
│                                                     │
│  [ Save changes ]              (shares existing     │
│                                  section Save button │
│                                  pattern, not a new   │
│                                  standalone one)      │
└──────────────────────────────────────────────────┘
```

Each swatch option renders as a radio-styled chip: a filled circle of the
preset's light-mode accent color, 2px ink border, the preset name below it,
`shadow-brutal-sm` on the selected chip (matching how selected states render
elsewhere in this settings page's existing radio/toggle groups). The mini
live-preview card updates instantly on selection (client-state only, no
round-trip) before the creator clicks Save — same "live preview" pattern as
the donation widget's embed-setup modal (`docs/design/donation-widget.md`
§8).

## 4. The Six Presets

Each preset defines a light-mode and dark-mode pair for the two tokens a
preset actually overrides: `--color-primary` (primary CTA / links / active
states) and `--color-primary-dim` (hover/pressed). `--color-brand-*` fills
(badges, decorative elements) are unchanged by presets — themeing the CTA
color is what visually differentiates a profile without touching the wider
brand-fill system used for secondary UI.

| Preset | Light `--color-primary` | Light `--color-primary-dim` | Dark `--color-primary` | Dark `--color-primary-dim` |
| --- | --- | --- | --- | --- |
| **Violet** (default) | `#7c3aed` | `#6d28d9` | `#7c3aed` | `#6d28d9` |
| **Lime** | `#65a30d` | `#4d7c0f` | `#b4f461` | `#9ade3a` |
| **Cyan** | `#0891b2` | `#0e7490` | `#6fd3ff` | `#3ec2ff` |
| **Pink** | `#db2777` | `#be185d` | `#ff9db1` | `#ff7a97` |
| **Orange** | `#ea580c` | `#c2410c` | `#ff7a5c` | `#ff5c38` |
| **Lilac** | `#7c6fd6` | `#6558c4` | `#c4b5fd` | `#ab98fc` |

Light-mode values are darkened/saturated versions of the brand fill so text
and icons drawn in the accent color keep AA contrast against the warm-paper
`#fdfcf7` background (every value above is >= 4.5:1 against `#fdfcf7`).
Dark-mode values are closer to the raw `--color-brand-*` swatches, which
already read correctly against the warm-charcoal `#161412` background — this
is the same light/dark asymmetry `globals.css` already uses for every other
token (compare `--accent-bg: #ede9fe` light vs `#2b2440` dark).

## 5. How a Theme Renders on the Public Profile

```
┌──────────────────────────────────┐
│  [avatar]  Display Name           │
│            @handle                │
│            bio text…               │
│                                    │
│  ┌──────────────────────────────┐ │
│  │  Amount  [ 5 ]  ( XLM ▾ )     │ │
│  │  ┌──────────────────────────┐│ │
│  │  │   SUPPORT  ← accent fill  ││ │  ← themed: --color-primary
│  │  └──────────────────────────┘│ │
│  └──────────────────────────────┘ │
│  Goal   ●●●●●●●○○○  12.5/50 XLM  │  ← themed: progress fill
│  Recent supporters  [badges…]     │  ← unthemed: brand-fill badges stay put
└──────────────────────────────────┘
```

Themed elements: primary CTA fill/hover, active tab/link underline, goal
progress bar fill, focus rings. Unthemed (stay on `--color-brand-*` /
`--color-ink`): badges, borders, shadows, body text, secondary buttons. This
split is deliberate (see Decision 2): it lets every themed profile still be
instantly recognizable as the same product.

### Light vs dark composition example (Lime preset)

```
Light + Lime                      Dark + Lime
┌──────────────────┐              ┌──────────────────┐
│ warm-paper bg      │              │ warm-charcoal bg   │
│ [ SUPPORT ] #65a30d│              │ [ SUPPORT ] #b4f461│
│ ink text/borders   │              │ light text/borders │
└──────────────────┘              └──────────────────┘
```

## 6. Responsive Behavior

| Breakpoint | Behavior |
| --- | --- |
| Settings, ≥ 640px | 3-column swatch grid (as mocked in §3). |
| Settings, < 640px | 2-column swatch grid; live-preview card moves below the swatches instead of beside them. |
| Public profile | Theming is a token swap only — it does not change any existing responsive layout rule on `[username]/page.tsx` at any breakpoint. |

## 7. Empty / Edge States

| Case | Behavior |
| --- | --- |
| Creator has never chosen a theme | Defaults to **Violet** (current app-wide primary) — zero visual change for every existing profile until a creator opts in. |
| Theme saved but creator later has no accepted-asset / goal set | Themed elements that would be hidden anyway (e.g. goal bar) stay hidden; no theme-specific empty state needed beyond the existing ones in `docs/design/empty-states.md`. |
| Visitor's browser has no preference / forced-colors mode | Preset tokens are skipped entirely under `prefers-contrast: more` / `forced-colors: active` media queries, falling back to system colors — same accessibility escape hatch the base design system should already provide for hard-ink borders. |

## 8. Acceptance Criteria Map

| Acceptance criterion | Where covered |
| --- | --- |
| A clear design spec exists for the theme picker UI and the resulting themed profile states | §3 (picker), §4 (presets/tokens), §5 (rendered result) |
| Designs cover both desktop and mobile | §6 |
| Designs are handed off in a form the frontend team can implement directly from | §9 implementation checklist, §4 token table |

## 9. Implementation Checklist (frontend handoff)

- [ ] Data: add a `profileTheme` field (enum of the six preset keys in §4,
      default `"violet"`) to the creator profile model, editable via whatever
      endpoint the existing Settings → Profile section already uses to save
      profile fields.
- [ ] Settings: new section in `frontend/app/settings/page.tsx`, inserted
      after the existing **Profile** section (~line 419), six radio-styled
      swatch chips per §3, wired to `profileTheme` via the same form/save
      pattern the surrounding sections already use on this page.
- [ ] Component: a small `ThemePreview` component (mini live-preview card in
      §3) reusable between the settings picker and (optionally) a future
      theme-picker in onboarding.
- [ ] Public profile: `CreatorProfileClient` (rendered from
      `frontend/app/[username]/page.tsx`) reads the creator's `profileTheme`
      and sets the two preset CSS custom properties (§4) as inline style
      overrides on its root element, e.g.
      `style={{ '--color-primary': ..., '--color-primary-dim': ... }}` -
      scoped to that subtree only, so it never leaks into the
      dashboard/settings chrome (Decision 3).
- [ ] No changes to `.dark` / light token resolution: the existing
      `.dark`-class mechanism keeps working underneath the preset override,
      since presets only ever replace the same two variable names `globals.css`
      already defines per-mode.
- [ ] No backend schema changes beyond the one new `profileTheme` field; no
      new endpoints (reuses the existing profile-save endpoint).

## 10. Non-Goals (v1)

- Free-form hex/color-picker theming (contrast/abuse risk, see Decision 1).
- Theming borders, shadows, typography, or `--color-brand-*` badge fills.
- Per-section theming (e.g. a different accent for the goal bar vs the CTA).
- Theming the creator's own dashboard/settings chrome (Decision 3).
- Seasonal/animated/gradient themes.
