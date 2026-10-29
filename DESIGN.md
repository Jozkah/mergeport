# Design (pre-build decisions; Kravio is the authority)

Mode: **Operate**. Reference inspected live: https://kravio-dashboard.vercel.app/ at 1024 and 390 px. Authoritative values measured from computed styles (not guessed).

## Measured from Kravio

- Canvas `#f8f8f8`; surface/card `#fff`; border `#e5e7eb`; ink `#1f2937`; secondary ink `#4b5563`; muted `#6b7280`; ring `#9ca3af`; primary = ink `#1f2937`.
- Font: Inter Variable, system fallback. Page title 24/500; panel title 14/500 secondary ink; nav 13/400.
- Sidebar 250px, no fill (sits on canvas). Search field h-32, radius 8, 1px border, shadow `0 4px 14px rgb(0 0 0/.04)`. Active nav item: white, 1px border `#e5e7eb`, radius 8, shadow `0 4px 7px rgb(0 0 0/.04)`; inactive: transparent border, secondary ink.
- Panel shell: outer panel radius ~12 with pale striped diagonal header (title + icon + controls), inset white content surface with radius 12 and `1px rgb(0 0 0/.1)` border, padding 16/14. Nested radius = outer radius minus inset.
- Bars: radius `8 8 4 4`, ghost gradient `#e6e6e6 → #e6e6e699`, selected `#37475d → #1f2937`, dark tooltip chip.
- Deltas: green/red small text; sparklines only with real history.
- Segmented/select controls: compact, 1px border, dark selected state.
- Mobile: sidebar collapses; panels stack full-width; same shell motif.

## Tokens (Tailwind theme, one source in `src/app/globals.css`)

Surfaces `--canvas --surface --surface-inset --stripe`; text `--ink --ink-2 --ink-3`; border `--line --line-strong`; state colors paired with icon+text: `needs-me` (blue), `waiting` (amber), `changes` (orange/red), `blocked` (red), `ok` (green), `unknown` (gray, dashed). Radii 6/8/12/16. Elevation: `shadow-hair` (0 4 14 /.04), `shadow-pop`. Spacing 4-based. Motion: 150ms close / 250ms open; row feedback <=150ms; targets only changed properties, never `transition: all`.

## Rules

- Neutral sans (Inter Variable) everywhere; monospace only for branch names, SHAs, paths. Tabular numerals on counts/dates/durations.
- Lucide only. Verify export names at use.
- Inset-panel motif for page-level panels only; no cards inside rows.
- GitHub label colors preserved via readable tinted chip (border + text derived from label hex).
- Gradients only faint, empty-state/onboarding accents (Silver Mist/Arctic Frost style); tables/boards/reading surfaces flat.
- Hit areas >=40px on compact desktop controls (visual size may be smaller with padded hit area), >=44px on touch.

## Source ledger

See `docs/source-ledger.md`.

## As built (finish notes)

- Panels: outer radius 16, inset 6, inner surface radius 9 (concentric: 16 = 9 + 1px border + 6px inset). Controls 32px tall with a 4px invisible halo (40px hit area), 44px on coarse pointers. Nav rows are 40px.
- Icons: one Lucide family, stroke 1.5 beside regular text, names verified against installed exports.
- Press feedback: `scale: 0.96` on buttons; hover/focus use color and border only. All transitions name their properties; no `transition: all`.
- Dialog motion uses the transitions.dev scale: modal 250ms open / 150ms close at scale 0.96; right-hand detail drawer 400ms / 350ms; the mobile navigation drawer 250ms / 150ms from the left. Reduced motion collapses all durations.
- Avatars use a pure-black 10% inset outline instead of a tinted border.
- Status vocabulary (always icon + text): Needs my review (blue, Eye), Waiting on team/external (amber, Users/Hourglass), Changes requested (orange, CircleAlert), Blocked (red, Ban), Approved (green, Check), Unknown (gray, dashed, CircleHelp).

## Dark theme

Same Kravio language, inverted surfaces: every colour is a semantic token in `src/app/globals.css`, defined once for light and overridden for dark (`:root[data-theme="dark"]`, and `prefers-color-scheme: dark` when no explicit choice is stored). Components never hold a colour of their own.

- Canvas `#0e1013`; surface `#15181c`; inset `#191d22`; ink `#e7e9ec`, secondary `#b3bac3`, muted `#8d95a1`; borders `#262b32` / `#363c46`. Primary = ink, inverted (`--color-ink-invert` is the text on an ink fill).
- Status colours keep their hue and flip lightness: text is the 300-level tint on a deep tinted fill with a muted border, still paired with icon and text.
- Label chips keep GitHub's colour as identity: the label's channels are the only inline style; `.chip` derives tint, border and readable text per theme.
- Shadows deepen (black at 30-60%); scrim is `rgb(0 0 0 / .6)`; the diagonal stripe in panel headers flips to a faint white.
- Bars: ghost `#2a3037`, selected `#e7e9ec → #b9c0ca`.
- Preference: Light / Dark / System in Settings plus a quick toggle in the top bar. Stored per device in a first-party cookie (`mp-theme`), never synced to a team. The server reads it and renders `<html data-theme>`, so the first paint is correct: no flash, no hydration mismatch. `theme-color` meta follows the scheme. Switching suppresses transitions for one frame so colours do not tween across the page.
- Contrast: a scripted audit of every text node against its composited background (4.5:1, 3:1 for large text) passes in both themes on the overview, planning, pull requests, issues, attention, repositories, team, sync and settings pages; label chips were checked analytically.

## Panel bezel (intentional nesting)

Panels follow Kravio's frame-and-inset construction: an outer frame (striped canvas, 1 px line, 16 px radius, 6 px padding) holds one inner surface (inset colour, 1 px edge, 9 px radius), so the outer radius equals inner radius + border + inset and the two read as one object. Impeccable's `nested-cards` detector flags this (`.panel > .panel-body`, one note on the sign-in page and in each panel). It was compared with Kravio's dashboard cards and is kept on purpose; nothing else nests surfaces beyond it except board cards inside their column, which is the established kanban pattern. Do not "flatten" it to silence the detector.

## Motion

Purposeful, short, interruptible, always tied to a state change. The full matrix (trigger, behaviour, tokens, reduced-motion alternative, keyboard behaviour, owner), the token table, measurements and the reference ledger live in `docs/motion.md`; the tokens and every keyframe live in `src/app/motion.css`.

- Tokens: transitions.dev scale (80 / 150 / 250 / 350 / 400 / 500 ms; `cubic-bezier(0.22, 1, 0.36, 1)`; 4-12 px distances; scale .96-.99; blur 2-3 px). Close is quicker than open; hover and press feedback is 120 ms; tooltips wait 80 ms.
- Ownership: CSS for state and short sequences, GSAP only for the board's layout glide (inner wrapper, scoped with `useGSAP`), dnd-kit for drag transforms, the View Transitions API for the theme cross-fade. No element property has two owners. Never `transition: all`, never blanket `will-change`.
- Where it moves: sub-navigation collapse, mobile drawer, dialogs, tooltips, the sliding segmented pill, board cards (glide, enter, leave, one-off ring), toast stack, form feedback (check draw, one shake), sync pill (label cross-fade, one ring when a state needs a person), changed numbers and bars, theme switch.
- Not animated, on purpose: table rows, typing, filters and search results, polling refreshes, unchanged counts, anything on first render or navigation.
- Reduced motion redefines the tokens (distance 0, scale 1, blur 0, short durations), so every keyframe becomes a short fade; the board glide becomes a one-off outline. Information never depends on motion: state is always text + icon + colour.
