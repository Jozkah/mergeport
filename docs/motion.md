# Motion

How Mergeport moves, why, and who owns each animation. The visual foundation is Kravio (a dense operations dashboard), so motion is small, fast and tied to a state change. There are no entrance sequences on navigation, no background animation, no bounce, tilt or particles.

Source of truth: `src/app/motion.css` (tokens, keyframes, component rules) and `src/lib/motion.ts` (reduced-motion hook, token readers for GSAP). Nothing else defines a duration or easing.

## Ownership rules

| System | Owns | Never touches |
| --- | --- | --- |
| CSS (`motion.css`) | state transitions and short bounded sequences: hover/press feedback, dialogs and drawers, collapse, tooltip, toast, form feedback, metric swap, skeleton, theme cross-fade | layout glide of board cards |
| GSAP (`Board.tsx`, `useGSAP`, scoped, `overwrite: "auto"`, `clearProps`) | the board's layout glide, on the card's **inner wrapper** only | the `<li>` (dnd-kit's), any CSS-animated property of the same node |
| dnd-kit | drag transforms of the `<li>`, the drag overlay and its drop animation | anything inside the card |
| View Transitions API | the page-wide theme cross-fade (`::view-transition-*` in `motion.css`) | per-element colour transitions during a switch |

No property of an element is animated by two systems. Enter/leave/ring classes (`card-enter`, `card-ghost`, `card-landed`) sit on the inner wrapper and animate opacity, grid rows and box-shadow; the GSAP glide animates only `x`/`y` on the same wrapper and is skipped for new cards, so they never overlap.

## Tokens

| Group | Tokens |
| --- | --- |
| Durations | `--duration-feedback` 120 ms (hover/press colour), `--duration-stagger` 40, `--duration-micro` 80, `--duration-quick` 150 (close, text swap, tooltip appear), `--duration-fast` 250 (open, tab pill, accordion, number swap), `--duration-medium` 350 (panel close, toast reposition), `--duration-slow` 400 (panel open, bar change), `--duration-very-slow` 500 (emphasis: success check), `--duration-loop` 1400 (skeleton pulse, only while work is pending) |
| Easing | `--ease-smooth-out` cubic-bezier(.22, 1, .36, 1) for movement; `--ease-in-out` for swaps; `--ease-out` for tooltips; `--ease-linear` for skeleton/spinner |
| Distance | 4 / 6 / 8 / 12 / 30 px (`--distance-micro` … `--distance-large`) |
| Scale | .96 / .97 / .98 / .99 (`--scale-large` … `--scale-tiny`) |
| Blur | 2 px / 3 px (`--blur-small`, `--blur-medium`) |

The scale follows the transitions.dev motion tokens. Rules: close is quicker than open; hover-in is immediate and feedback never exceeds 150 ms; tooltips wait 80 ms for intent and skip the wait between neighbours; no `transition: all`, no blanket `will-change` (both grep-verified absent in `src`).

### Reduced motion

`@media (prefers-reduced-motion: reduce)` redefines the tokens instead of switching animations off: distances 0 px, scales 1, blur 0, durations 100–200 ms. Every keyframe therefore becomes a short opacity fade without code changes, and anything positioned from a token (toast stack offsets, drawer travel) stops moving. Where a fade is not enough to keep information, there is an intentional alternative (see matrix). The board glide is replaced by a one-off outline; the theme View Transition and sliding pill are short fades.

## Motion matrix

Trigger, behaviour and tokens per interaction. "Keyboard" is what a keyboard user gets; "Owner" is the implementing file.

| # | Interaction | Trigger | Visual behaviour | Tokens | Reduced motion | Keyboard / focus | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Sidebar expansion, mobile nav | chevron button on a section; "Open navigation" on narrow screens | Sub-nav collapses with grid-rows 1fr→0fr + opacity, chevron rotates; the mobile drawer slides in from the left (30 px, fades) and out 8 px | fast / smooth-out; drawer-left 250 ms in, 150 ms out | collapse and drawer become 100–120 ms fades | button has `aria-expanded`/`aria-controls`; collapsed content is `inert`; drawer traps focus, Escape closes, focus returns to the trigger (verified) | `Sidebar.tsx`, `Collapse.tsx`, `motion.css` |
| 2 | Dropdowns, menus, tooltips, popovers | hover/focus on a control with a `Tip`; native `<select>` for choices | Tooltip fades in with scale .98 and 4 px rise after an 80 ms intent delay, closes faster; no custom dropdown menu or popover exists in the app (selects are native and use the browser's own popup) | micro delay, quick close, ease-out | no scale or rise, fade only | opens on focus, Escape closes (Radix); non-focusable triggers are given `tabIndex` or sit on a link | `Tooltip.tsx`, `.tip` |
| 3 | Tabs and segmented controls | choosing a view or PR tab | A single pill slides (transform + width) under the active link; first placement is not animated | fast / smooth-out | pill moves as a short fade | links stay normal tab stops; `aria-current`; the pill is decoration | `Segmented.tsx`, `.seg-ind` |
| 4 | Detail panels, dialogs, confirmations | merge sheet, forms in dialogs | Scale .96 + fade in, softer out; scrim fades | fast open, quick close | fade only | Radix focus trap, Escape, focus restore | `dialog.tsx`, `MergeSheet.tsx` |
| 5 | Board: drag, drop, keyboard move, remote update | pointer drag; handle + Space/arrows; per-card "Move to" select; teammate change arriving by refresh | Pointer drag: dnd-kit transforms, 250 ms drop animation. Any other move (select, rollback, remote): cards glide from their previous place. New card rises in 6 px; removed card leaves from its place (grid-rows collapse, fade); a card changed remotely rings once | fast / smooth-out; ring = very-slow + fast | no glide; cards that really changed column (not the user's own) get the outline once | handle button carries the keyboard drag; select keeps focus after a move and after a roll-back; incoming data never moves focus or scroll; unchanged cards are never touched | `Board.tsx` (GSAP), `motion.css` |
| 6 | Task create / edit / delete / restore | "Add card" form; a teammate editing, adding or removing a card | Create: the card rises in when it arrives, form shows the success check. Edit by a teammate: one outline ring. Delete by a teammate: the card leaves from its old place. Editing a card title, deleting a card and restore do not exist as local actions in Mergeport, so there is nothing to animate for them beyond the remote cues | as row 5 | as row 5 | the ghost of a removed card is `inert` and `aria-hidden` (no ghost tab stop) | `Board.tsx`, `ActionForm.tsx` |
| 7 | Filters, search, empty states | typing, changing a filter, no results | Intentionally static: results swap without animation so typing never lags. Empty states fade in (`empty-in`) once | quick / ease-out | fade only | no focus change | `primitives.tsx` |
| 8 | Loading placeholders and replacement | route `loading.tsx`; pending server actions | Skeleton pulses (linear) only while real work is pending; content replaces it without a second entrance. Buttons show a spinner with the same label; after 3 s an extra "still working" hint appears | linear | no pulse; static placeholder | `aria-busy` on pending controls; hint is in a stable status region | `loading.tsx`, `ActionForm.tsx`, `.skeleton` |
| 9 | Sync, pending, offline, reconnecting, conflict, revoked | change in sync state | Pill label cross-fades (no movement); entering a state that needs a person (conflict, revoked, offline, rate-limited, schema) rings the pill once; coming back after offline shows "Reconnecting" while the queue drains. Always text + icon + colour | quick; ring = very-slow + fast | colour/text only, no ring movement | one polite announcement per change (`SyncAnnouncer`); the badge is a link (single tab stop) on the top bar | `SyncBadge.tsx`, `SyncAnnouncer.tsx` |
| 10 | Form validation, submission, success, failure | submitting any `ActionForm` | Pending: button disabled + spinner. Success: check mark draws (stroke) and the message rises. Failure: message rises, the row shakes once (6–8 px, 320 ms). Messages are static, readable text | very-slow check, micro×4 shake, fast rise | no shake or draw; message appears with a short fade | status and alert regions are permanent, so announcements do not depend on mounting; focus is never moved by feedback | `ActionForm.tsx` |
| 11 | Toast appearance, stacking, dismissal, focus | board moves, errors, sync changes | Newest rises 12 px with a 3 px blur; older ones step back (6 px, scale .96 per level); at most 3 visible, the oldest leaves with its exit; a repeated message within 1.5 s is merged. Confirmations leave after 4 s, errors stay | medium in, quick out | fade only; stack offsets collapse because they come from tokens | Escape dismisses the newest (not when a dialog or tooltip already used the key); timers pause while the stack is hovered or focused; every toast has a labelled dismiss button; two permanent live regions announce (polite/alert); toasts never take focus | `ToastProvider.tsx` |
| 12 | Theme changes | Light/Dark toggle or Settings | The page cross-fades once through a View Transition (measured: ready 5–8 ms, finished ≈ 270 ms); colour transitions and the header blur are suppressed during the switch so nothing smears or flashes; only the newest switch ends the suppression; the first paint is already themed by the server | quick | fade only | toggle has `aria-pressed`; no focus change | `ThemeControls.tsx`, `motion.css` |
| 13 | Charts and changed metrics | a count or chart value changes | Numbers re-enter with a 4 px blurred slide only when the value actually changes (never on first render, navigation or an unchanged poll). Bars grow in height (400 ms) and the overview meter wipes via clip-path when their value changes | fast number swap; slow bars | numbers fade; bars/meter change without travel | values stay real text for assistive technology; nothing is announced for decoration | `Metric.tsx`, `OpenedChart.tsx`, `page.tsx` |

## Evidence

Measured in headless Chromium against the production build with the synthetic demo data set (no GitHub contact). These are measurements of this machine, not guarantees for others; no frame-rate target is claimed.

| Check | Result |
| --- | --- |
| Frame intervals during idle, card glide, sub-nav collapse, three-toast stack, dialog open, theme switch | p50 6.9 ms, p95 7 ms, max ≤ 14 ms; 0 frames > 20 ms; 0 long tasks |
| Layout shift sums over the same interactions | 0 – 0.083 |
| Theme switch | View Transition ready 5–8 ms, finished ≈ 269 ms. Before the fix (header `backdrop-filter` in the snapshot) the snapshot took ≈ 1 s |
| Reduced motion emulated | tokens collapse (distance 0 px, scale 1, blur 0, fast 120 ms); the card move produced no glide but the outline; toast animation `toast-in` 150 ms; tooltip has no animation |
| Dark theme contrast (computed from rendered colours) | toast text 14.64:1, toast icon 12.68:1, tooltip 14.64:1 |
| Mobile 390 px | no horizontal overflow; drawer 250 ms (120 ms reduced), focus lands in the dialog, Tab stays inside after 25 presses, Escape closes and focus returns to "Open navigation"; four rapid open/close cycles leave no dialog, scroll lock or pointer lock behind |
| 200 % zoom (640 × 400 CSS px) | no horizontal overflow on overview, board, pull requests, sync; toast fully inside the viewport |
| Repeated navigation (overview, attention, board, pull requests) | no entrance keyframe is running after navigation; only colour transitions on hover targets |
| Impeccable detector | regex pass over `src/app` and `src/components`: no findings; live page (`/`, which redirects to the sign-in page when not signed in): `nested-cards` notes about the panel and its inset body. Triaged against Kravio: intentional (see DESIGN.md, "Panel bezel"), not a defect |

### Before / after

"Before" is the previous round of this repository (a modal CSS block, a sliding pill, a card glide and one toast), not re-run here.

| Aspect | Before | After |
| --- | --- | --- |
| Tokens | durations and easings written inline in several files | one token scale, reduced-motion collapse defined once |
| Sub-nav, tooltips, sync pill, forms, metrics, bars, empty states | no motion or abrupt swaps | state-tied transitions listed above |
| Toasts | single toast | stack of three, merge, pause on hover/focus, error persistence, live regions |
| Board | glide for every moved card, even unchanged ones after a refresh | glide only for cards that moved; enter / leave / ring cues for remote changes; focus and scroll untouched |
| Theme switch | per-element colour tweens (smear) | single cross-fade, no flash, no delay of the swap |

## Reference ledger

Public pages only; nothing purchased, no template downloaded, no account created. Refero's skill and connector were **not** installed or used. Inspection was done by loading each page in a scripted browser and reading its stylesheets (`@keyframes`, transition declarations, reduced-motion rules) and the animations running after load or a click. A script cannot judge feel, so "observed" below means the declared and running animation values, not a viewing of playback. Slowed playback of the references was not available with these tools; screenshots were taken only for getlayers.ai and 60fps.design.

| Reference | URLs visited | Observed | Adopted / rejected | Limits |
| --- | --- | --- | --- | --- |
| Kravio (authority) | https://kravio-dashboard.vercel.app/ | Keyframes `rise-in` (8 px), `fade-in`, `draw-x`, `grow-y`, `pop`, `dd-in` (−4 px, scale .97), `dd-out`, `ring`, `wave`, `ping`; reduced-motion rule present; nav group toggle animates rotate, grid-template-rows, margin-top and opacity in 300 ms with cubic-bezier(.16, 1, .3, 1); sidebar collapse animates width 300 ms; hover transitions 150 ms on colour/shadow | Adopted: grid-rows collapse with chevron rotation, short dropdown/tooltip scale-in (.97–.98 with 4 px), 150 ms hover feedback, `grow-y`/`draw-x` idea for bars and meter. Rejected: `ping` loops, `ring`/`wave` rotations, `pop` overshoot (scale .6 → 1.12), `transition: all` on cards | Menus did not open under script (pointer events intercepted), so dropdown behaviour comes from its keyframes only; sidebar collapse width animation not used (Mergeport has a fixed sidebar) |
| GetLayers | https://www.getlayers.ai/, https://www.getlayers.ai/layer/vesper | One `pulse` keyframe, no transitions declared; cinematic landing content | Rejected: landing-page style motion; nothing adopted | Marketing pages; screenshot only, no interaction applicable |
| Curated | https://curated.design/, https://curated.design/inspiration/, https://curated.design/sections/ | `media-skeleton-shimmer` 1.4 s linear, `chat-tray-in` (8 px), `lightbox-rise` (12 px, scale .99), translate 240 ms cubic-bezier(.22, 1, .36, 1), reduced-motion rules (8) | Adopted: skeleton pulse timing, 8–12 px rise with tiny scale, the same smooth-out curve. Rejected: lightbox | Gallery of sites; no product UI to copy |
| 60fps | https://60fps.design/, https://60fps.design/shots/filter/bottom-sheet | Framer-built; hover transitions 150–200 ms; catalogue of recorded mobile interactions (videos) | Used only to confirm sheet/drawer expectations (short slide, scrim fade); nothing copied | Videos did not play in the scripted browser, so recorded interactions were not watched; screenshot of the bottom-sheet filter page only |
| Refero | https://refero.design/, https://refero.design/web-apps, https://refero.design/pricing | `move-in`/`move-out` 100 % translate (text swap), many `all` transitions at .2–.3 s, 3 reduced-motion rules | Rejected: `all` transitions, slot-style text translation; nothing adopted | Public pages only; its skill and connector were not used. Gated search results not inspected |
| React Bits | https://reactbits.dev/, https://reactbits.dev/components/animated-list | `lh-rise` (blur 8 px, 16 px), spring-like `linear()` easing (≈ 8 % overshoot), 34 reduced-motion rules, decorative backgrounds | Adopted: respect for reduced motion as a first-class path; blur-in as a small token (2–3 px only). Rejected: spring overshoot, decorative backgrounds, marquees | Component demos are showpieces; the pro tier is gated and was not inspected |
| Aura Gradients | https://auragradients.vercel.app/ | `toast-in` (16 px, scale .96), `toast-out` (8 px, .96), `select-in` (−4 px, .97), `card-flash` ring (6 px, 50 %) | Adopted: toast in/out geometry, select/tooltip scale, one-off ring for changed items (as 3 px outline) | Single-page tool |
| Lucide | https://lucide.dev/icons/bell | Icons are static; page fade-in only; no animated preview | Adopted: icons stay static, 2 px stroke, no icon animation | Library already a dependency; nothing else to take |
| Webild | https://www.webild.io/templates | Sonner-style toast keyframes (scale .8, swipe-out), shimmer sweep | Rejected: swipe-out and scale .8 (too large); templates not purchased | Templates are paid; only the public listing page was loaded |

## Limits and what is not verified

- Real GitHub was not involved; the motion was exercised on the synthetic demo data set and the local database.
- No touch-device or real-OS reduced-motion setting was tested; reduced motion was emulated through the browser (`prefers-reduced-motion`).
- Frame data come from headless Chromium on one machine; no 60 fps (or any) target is claimed.
- Slowed-down playback of the running app was not performed; keyframe values and running animations were read from the browser (`getAnimations()`), not watched.
- Known small gaps accepted after the review: a toast dismissed during its own entry fades from full opacity; the "own move" suppression for the board ring lasts 4 s, so a push echo arriving later than that can ring the user's own card once; keyboard focus is not moved after a toast is dismissed with its button.

## Correction after first use

The sub-navigation groups opened to the right height but their links were invisible. Cause: the class `.collapse` is also a Tailwind utility (`visibility: collapse`), so every open group was hidden. The first round measured height and opacity, not visibility, and missed it. The class is now `.disclosure`, `tests/motion-guard.test.ts` rejects class names that are Tailwind utilities, and the fix was checked by reading the links' computed visibility and hit-testing them on screen (load on an active section, expand, collapse).

## Icon reactions and the mark (added after first use)

Reused from Flint's web app (`web-app/src/index.css`, the same family as Kravio's keyframes; read from a local checkout): `pop` (as `icon-pop`, peak `--scale-pop`), `ring` (as `icon-ring`, swing `--rotate-ring`), `sb-in` (as `slide-in-left`, the mobile drawer entries, 40 ms stagger) and `draw-x`'s idea (the mark's branches draw in). Rejected: `wave`, `wave-bar`, `twinkle`, `ripple` and blur entrances (too playful for an operations dashboard).

| Interaction | Behaviour | Reduced motion |
| --- | --- | --- |
| Hover or keyboard focus on a sidebar link or button with an icon | the icon pops once (350 ms) | no movement (scale token 1) |
| Bell | swings on hover and once when the unread count goes up | none |
| Refresh icons | turn half a turn on hover (spin while pending) | none |
| Mobile drawer | entries slide in one after another | short fade |
| Mergeport mark (sidebar, sign-in) | the two branches draw in and the port pops on hover or focus | none |

Chevrons and the theme toggle keep their own animation and are excluded from the pop, so no element has two animations on the same property. The app icon is `src/app/icon.svg` (the same mark).
