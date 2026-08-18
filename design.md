# Design — Viron

A locked design system for the Viron app. Shared Web, macOS, and Windows views
use this system together; page-level redesigns extend it instead of inventing a
new theme.

## Genre

Modern-minimal, technical, and utilitarian. Viron is an operational workbench,
so information hierarchy and scan speed take priority over decorative surfaces.

## Macrostructure Family

- App pages: Workbench. Use an unframed compact title-and-actions toolbar, an
  optional summary rail, and one primary operational surface. Do not place page
  descriptions, metadata, icons, or explanatory copy in the page toolbar.
- Frameless desktop shells reserve the platform title-bar height before page
  content and expose that reserved strip as the window drag region. Native
  window controls must never overlap page actions or workbench surfaces, and
  their surface and symbol colors follow live app theme changes.
- Workbench pages: Full-height instrument panels using the same tokens at higher
  information density.
- Content pages: Long-document rhythm, typography only.

## Theme

- Paper: neutral white-gray, never green-tinted or pure white.
- App paper carries a low-contrast 22 px engineering grid across shared Web and desktop surfaces; operational panels stay solid for legibility.
- Ink: green-tinted near-black.
- Accent: Viron teal, reserved for focus, active state, primary action, and status.
- Warning and danger colors always include text or icons; color is never the only signal.

Canonical values and compatibility aliases live in `tokens.css`.

## Typography

- Display: DIN Alternate / Avenir Next Condensed, weight 800, roman.
- Body: Avenir Next / PingFang SC, weight 400–700.
- Mono: JetBrains Mono, used for addresses, identifiers, dates, and query text.
- Page titles are compact and never exceed `--text-page-title`.

## Spacing

Use the named 4-point scale from `tokens.css`. Operational pages prefer 8, 12,
16, 24, and 32 px intervals; no raw spacing values in new shared components.

## Motion

- Easings: `--ease-out`, `--ease-in`, and `--ease-in-out`.
- Motion is limited to press feedback, disclosure state, and one panel entrance.
- Reduced motion collapses spatial movement to an opacity change of at most 150 ms.

## Microinteractions Stance

- Keyboard focus is immediate and visible.
- Buttons stay single-line and preserve a 40–44 px touch target where space allows.
- Loading stays local to the initiating control or surface.
- Success is quiet when the resulting state is already visible.

## CTA Voice

- Primary commands use the Element Plus primary button with a Lucide icon.
- Secondary commands use neutral borders and the same height as adjacent inputs.
- Destructive commands remain visually separate and use explicit wording.

## Per-page Allowances

- App pages must not use decorative enrichment; the data and controls carry the page.
- Summary rails may show only real values returned by the application.
- Tables can remain dense on desktop, but secondary columns collapse or scroll on narrow views.
- Explanatory cards, subtitles, intro paragraphs, placeholder descriptions, and
  empty-state narration are not part of the app UI. Keep only labels, live data,
  status, warnings, errors, and operation results.
- Guidance that is genuinely required for security, permissions, or irreversible
  behavior uses the shared `TipIcon` help control and appears on hover or focus.

## What Pages Must Share

- The page header, Viron teal placement, font roles, control radius, focus ring,
  empty-state voice, and status language.
- A single containment layer per operational surface. No card inside card.

## What Pages May Differ On

- Whether the main body is a directory, data table, event stream, or settings console.
- Whether the summary rail is interactive.
- Density of rows and columns according to task frequency.

## Exports

The canonical CSS export is `tokens.css`. The existing Element Plus and legacy
variable names map to the same values there so older workbench components remain
visually compatible during incremental redesign.
