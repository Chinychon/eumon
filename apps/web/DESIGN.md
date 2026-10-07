---
name: Eumon
description: Operator console that runs client sites through the organic growth pipeline, drawn as a ruled workbench where work visibly grows.
colors:
  paper: "#f4f5ee"
  paper-rail: "#ecefe5"
  paper-surface: "#fbfcf7"
  paper-surface-2: "#eef0e7"
  paper-surface-3: "#e3e7dc"
  forest-ink: "#132015"
  forest-ink-2: "#2c3a2e"
  muted: "#566358"
  soft: "#5e6a60"
  line: "rgba(19, 32, 21, .1)"
  line-strong: "rgba(19, 32, 21, .17)"
  control-line: "rgba(19, 32, 21, .5)"
  primary: "#1e3d1f"
  primary-hover: "#2a5229"
  on-primary: "#f4f5ee"
  green: "#239a63"
  green-ink: "#1c6b44"
  green-soft: "rgba(35, 154, 99, .14)"
  amber: "#96600f"
  amber-fill: "#e3a73a"
  amber-tint: "rgba(227, 167, 58, .16)"
  red: "#b23c2b"
  red-tint: "rgba(196, 72, 52, .1)"
  track: "rgba(19, 32, 21, .07)"
  carried: "#8aa38d"
  series-sprout: "#2f7d4f"
  series-sun: "#d79a2b"
  series-sky: "#4f8bbf"
  series-clay: "#c46a48"
  night: "#0f1411"
  night-rail: "#0c100e"
  night-surface: "#151b17"
  night-surface-2: "#1b231e"
  night-surface-3: "#232d26"
  night-ink: "#edf2ea"
  night-ink-2: "#c9d3c8"
  night-muted: "#9aa59b"
  night-soft: "#808b82"
  night-line: "rgba(224, 238, 226, .09)"
  night-line-strong: "rgba(224, 238, 226, .15)"
  night-control-line: "rgba(224, 238, 226, .4)"
  night-primary: "#4fd394"
  night-primary-hover: "#6ee0a8"
  night-on-primary: "#08160d"
  night-question: "#1d2a21"
  night-green: "#45c886"
  night-green-ink: "#7fdcaa"
  night-amber: "#f0b45a"
  night-red: "#f08470"
  night-carried: "#5d7a62"
  night-series-sprout: "#63cf8f"
  night-series-sun: "#f0b45a"
  night-series-sky: "#7fb4e2"
  night-series-clay: "#e69172"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: "-.03em"
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-.025em"
  greeting:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "-.025em"
  figure:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 400
    letterSpacing: "-.02em"
    fontFeature: "tnum"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    letterSpacing: "-.01em"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-small:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: ".1em"
  nav:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: ".08em"
  code:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  none: "0"
spacing:
  xs: "8px"
  sm: "14px"
  md: "20px"
  lg: "28px"
  xl: "44px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.paper-surface-2}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.forest-ink}"
    padding: "0 10px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.green-soft}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.red}"
    padding: "0 12px"
    height: "36px"
  button-small:
    padding: "0 12px"
    height: "30px"
  input:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
    height: "38px"
  card:
    backgroundColor: "{colors.paper-surface}"
    rounded: "{rounded.none}"
    padding: "20px 22px"
  panel:
    backgroundColor: "{colors.paper-surface}"
    rounded: "{rounded.none}"
    padding: "18px 20px 10px"
  badge:
    backgroundColor: "{colors.paper-surface-2}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 10px"
    height: "22px"
  badge-green:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green-ink}"
  badge-amber:
    backgroundColor: "{colors.amber-tint}"
    textColor: "{colors.amber}"
  badge-red:
    backgroundColor: "{colors.red-tint}"
    textColor: "{colors.red}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.nav}"
    padding: "0 12px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.paper-surface-2}"
    textColor: "{colors.forest-ink}"
  ask-question:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    padding: "10px 16px"
  ask-send:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    size: "38px"
  progress:
    backgroundColor: "{colors.track}"
    height: "6px"
---

# Design System: Eumon

## Overview

**Creative North Star: "The Ruled Garden Workbench"**

Eumon tends client sites like a garden, drawn on a ruled workbench. The structure is Better Auth's: every surface is drawn with 1px hairlines that meet at square corners, panels share their rules with their neighbours by overlapping a pixel, and the work column is framed by full-height verticals with small + marks where rules cross. The only soft things are the colour and the motion.

There are two themes and both are warm. Day is green-tinted paper with deep forest ink; night is forest-charcoal with visible tonal steps, never pure black. The page follows the device until the operator picks Light or Dark in the rail's toggle; the choice is saved per browser and set before first paint. Green carries growth: progress, positive state, and the pixel garden. Sun, sky, and clay join it only as data colours.

Pixel sprites are the only illustration: a sprout brand mark, a seedling on Ask, and the crawl garden where one plant sprouts per crawled URL and the bed blooms when an analysis finishes. Rounded, shadowed SaaS cards and the cold pure-black console are both rejected.

**Key Characteristics:**
- Square corners everywhere; 1px hairlines; adjacent blocks share one rule via a -1px overlap.
- The shell frame: rail rule, top-bar rule, full-height column verticals, + marks at the crossings.
- Warm paper light and warm forest-night dark, device default plus a three-way toggle.
- Geist for titles and prose at 400/500; Geist Mono uppercase for machinery.
- Green for primary, progress, and positive state; four series colours for data; pixel palette for the garden.
- Motion that grows and settles on one ease-out curve, all of it off under reduced motion.

## Colors

Warm, low-chroma neutrals on a green axis, one growth green, two alarm colours, and four data colours, each defined twice: paper (light, the frontmatter's unprefixed tokens) and night (dark, `night-*`). Components use the role, never the theme value; the theme swaps underneath.

### Primary
- **Deep Forest / Mint** (`primary`, `night-primary`): fill of the primary button and the Ask send button, the brand mark square, and (in light) the asked question. Deep forest by day with paper text; bright mint by night with near-black text. Hover lightens to `primary-hover`.
- **Sprout Green** (`green`, `night-green`): progress fills, the active stage's pulsing square, the active nav marker, the fetched segment of a split bar, connected markers in the Connections strip, focus outlines, input focus borders, caret, list markers, and Ask's step icons. `green-ink` is its text-safe form (badges, links, kinds, falling deltas); `green-soft` is its tint (selection, active stage, finished card, ghost and chip hover, arrival flash, focus halo).

### Secondary (data)
- **Sprout, Sun, Sky, Clay** (`series-sprout`, `series-sun`, `series-sky`, `series-clay`; night variants brighter): chart series in that order. Bars use Sprout, funnels use Sky, lines use the first three.
- **Carried Sage** (`carried`): the segment of a split bar for work reused from the previous run, and its legend square.

### Tertiary (signal)
- **Harvest Amber** (`amber` text, `amber-fill` solid, `amber-tint` wash): warnings, queued/draft/pending badges, high severity (full tint) and medium severity (55% tint), the stalled run's active stage, crawl notes.
- **Clay Red** (`red`, `red-tint`): errors, failed/blocked/thin/duplicate badges, critical severity, danger buttons, failed checks, bad counts, rising problem counts in run deltas.

### Neutral
- **Paper / Night** (`paper`, `night`): the page ground and the drawer.
- **Rail** (`paper-rail`, `night-rail`): the sidebar, one step off the ground.
- **Surface** (`paper-surface`, `night-surface`): cards, panels, tables, inputs, badges' neighbours; the sheet everything is drawn on.
- **Surface 2** (`paper-surface-2`, `night-surface-2`): table heads, row hover, callouts, code, tile header strips, active nav, the run confirm box.
- **Surface 3** (`paper-surface-3`, `night-surface-3`): disabled primary fills, tile action hover.
- **Ink, Ink 2, Muted, Soft**: headings and figures; table and answer prose; ledes and secondary prose; mono labels, placeholders, captions.
- **Line** (`line`): every structural rule. **Line Strong** (`line-strong`): borders of secondary buttons, chips, the dashed empty state. **Control Line** (`control-line`): input, select, and composer borders and the chart cursor.
- **Question** (`night-question`): in dark, the asked question sits on a raised forest step with a Line Strong border; in light it uses `primary`.

### Pixel palette
Garden and sprite colours live only in the sprites, each defined per theme: leaf, leaf 2, stem, soil, soil 2, seed, wilt (empty HTML), error, stone (blocked), reused, bloom, bloom 2, pot, pot 2. Values are in `globals.css` (`--px-*`) and the sidecar.

### Named Rules
**The Growth Green Rule.** Green means the site is moving forward: the primary action's family, progress, active place, and positive state. It is not decoration and not a chart's only colour.

**The Alarm-Only Rule.** Amber and red carry warnings and errors and nothing else.

**The Warm Ground Rule.** Neither theme uses pure black or pure white; both grounds and inks carry the green-warm tint.

## Typography

**Display Font:** Geist (with ui-sans-serif, system-ui)
**Label/Mono Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo)

**Character:** Geist at regular weight gives large titles a calm, engineered voice; Geist Mono in small uppercase with wide tracking marks everything that is system rather than prose. Weights are 400 and 500.

### Hierarchy
- **Display** (400, 44px, 1.08, -.03em; 32px under 760px): the first-run welcome title.
- **Headline** (400, 36px, 1.1, -.025em; 28px under 760px): one title per view, with a Muted lede (14px, 1.6, max 640px).
- **Greeting** (400, 30px, 1.15; 25px under 760px): the Ask home greeting.
- **Figure** (400, 28px, -.02em, tabular): KPI values; 30px for the live crawl count, 22px in run tallies.
- **Title** (500, 16px, -.01em): card and panel headings; 17px for run and finished heads. Row headings drop to 13-14px at 500.
- **Body** (400, 14px, 1.5): base text and Ask answers (1.65, max 62ch). Secondary prose at 13px (1.55) or 12.5px.
- **Label** (Mono 400, 11px, .1em, uppercase, Soft): KPI labels, table heads, section titles, stage names, tile header strips, trace summary.
- **Nav** (Mono 400, 12px, .08em, uppercase): rail items, tabs (.06em), badges (11px, .06em), the Connections strip (11.5px), the wordmark (13px, 500, .14em). The breadcrumb is mono 12px at .04em, not uppercase.
- **Code** (Mono 12.5px, 1.6): code blocks, mono values, step rows (11.5px).

### Named Rules
**The Mono-for-Machinery Rule.** Navigation, column heads, counts, codes, paths, timings, and step rows are Geist Mono. Titles and sentences are Geist.

**The Regular-Weight Rule.** Large titles are 400, never bold; emphasis at body sizes is 500.

**The Tabular Rule.** Figures, table numbers, scores, timings, and deltas use tabular numerals; numeric columns align right.

## Layout

A fixed left rail (236px; 200px under 1050px) beside the main area. The rail's brand row and the top bar are both 59px, so their bottom rules form one line. The work column is centred, `calc(100% - 64px)` wide up to 1190px, padded 44px 40px 32px, and bounded left and right by full-height hairlines.

Grids are cells, not gaps: step cards, KPI strips (auto-fit, min 160px), metric grids (4 columns, 2 under 760px), split layouts (1.15fr / .85fr), and stacked cards overlap by -1px so neighbours share a rule. The Overview is one ruled stack: KPI strip, run or finished card, Connections strip, then a tab row (Overview · Technical · Search · Competitors · Leads, kept in `?tab=`). The Overview tab is a one-screen briefing: a 2fr / 1fr row (where pages break | do first) over three equal chart cards, each opening its tab. Report grids (`.ruled-grid` c11, c21, c3) share rules like the rest and stack to one column under 760px (c3 already under 1050px).

Rows and tables inside a card or panel bleed to its edges: findings, opportunities, competitors, list rows, and template rows extend by the panel's `--pad` on both sides so their rules meet the frame, and a table placed directly in a panel or tile drops its side borders and pads its first and last cells by `--pad` instead.

Spacing rhythm: 8px inside rows and controls, 14px between stacked fields and callouts, 18-22px panel and card padding (16px under 760px), 28px below the view header.

Breakpoints: at 1440px and wider the open Ask drawer pushes the page (440px right margin) and split layouts stack; under 900px splits, forms, and run tables go to one column; under 760px the rail becomes a horizontally scrolling top strip (brand pinned, labels hidden, site switcher and toggle at the end), the top bar drops to 48px, the column loses its side rules with + marks moved in to 12px, stages stack as rows, and wide tables scroll (min 560px).

## Elevation & Depth

Flat sheets on a warm ground. Depth comes from hairlines and three tonal surface steps. One shadow exists, and only things that float over content carry it.

### Shadow Vocabulary
- **Pop** (`--shadow-pop`; light `0 24px 60px -24px rgba(19, 32, 21, .38), 0 2px 8px rgba(19, 32, 21, .08)`, dark `0 28px 70px -24px rgba(0, 0, 0, .8), 0 2px 8px rgba(0, 0, 0, .4)`): the flash toast, the garden tooltip, the chart readout, the Ask drawer.

Focus is drawn, not lifted: a 2px Sprout Green outline at 2px offset, and on fields a green border plus a 3px `green-soft` halo. Inset 1px shadows stand in for borders on the theme toggle, and a 2px inset green underline marks the active tab.

### Named Rules
**The Floats-Only Shadow Rule.** Panels, cards, tiles, and controls never cast shadows. Only the toast, tooltip, readout, and drawer do.

## Shapes

Square. Panels, cards, buttons, inputs, selects, the composer, badges, chips, severity tags, tiles, the drawer, toggle, progress bars, and chart bars all have 0 radius. Status dots and markers are squares too (6-8px), and the active nav marker and pulsing progress square rotate 45° into diamonds. The loading spinner is the only circle.

Borders are 1px solid Line for structure, Line Strong for secondary controls, Control Line for text entry. Dashed Line Strong marks the empty state (1.5px) and the add-website button.

### Named Rules
**The Square Rule.** No radius anywhere except the spinner.

**The Registration Mark.** A 9px + drawn from two 1px Muted lines sits where the work column's verticals meet the top bar's rule and where the rail meets it. It belongs to the shell frame.

## Components

### Buttons
Square, 36px, 13px at 500, with an 8px gap for an inline spinner. Every press scales to .97 on the shared ease.
- **Primary:** `primary` fill, `on-primary` text, 0 16px; hover to `primary-hover`; disabled falls to Surface 3 with Muted text. One forward action per view header.
- **Secondary:** Surface fill, Ink text, Line Strong border; hover raises to Surface 2 with a Control Line border.
- **Ghost:** transparent, underlined in Line Strong (offset 4px); hover turns the underline green on a `green-soft` wash.
- **Danger:** red text, no fill; hover adds `red-tint`.
- **Small:** 30px, 0 12px, 12px text. Disabled secondary, ghost, and danger drop to 50% opacity.

### Badges, severity, chips
- **Badge:** 22px, mono 11px uppercase, Line border on Surface 2, Muted text. Tones come from the status word: green (published, active, approved, completed, live, running), amber (proposed, draft, queued, pending), red (thin, duplicate, failed, rejected, blocked), gray otherwise. Toned badges drop the border.
- **Severity:** a mono 11px tag in the finding's 112px first column: critical red on red tint, high amber on amber tint, medium amber on a 55% amber tint, low Ink 2 and info Muted on Surface 2.
- **Chip:** Line Strong border on Surface, 12px Ink 2, with a drawn cross to remove.
- **Count pill:** mono 11px Muted on Surface 2 beside panel headings.

### KPI strip
A ruled grid of cells (auto-fit, min 160px) sharing rules: 16px padding, mono Label, 28px regular Figure, 12px Muted caption. On the Overview it is the first block of the stack. Counts tween between polls (900ms cubic ease-out).

### Connections strip
One full-width ruled button line between the run card and the report: a Muted mono "Connections" label, then each source as mono uppercase with a 6px square marker (outlined Soft when off; filled green with Ink 2 text when on), and "Open connections" in `green-ink` at the right, which nudges 3px right on hover while the strip rises to Surface 2. The full Connections view is its own tab of ruled list rows.

### Run panel
A running analysis is one ruled card whose sections are separated by rules, rising in on load.
- **Head:** a 17px title, Muted subtitle, ghost actions, a mono note; a Surface 2 confirm box for stopping.
- **Stage track:** five cells divided by rules; finished stages lead with a drawn check that draws in; the active cell is `green-soft` with a pulsing green square; durations in mono. Stalled: the active cell turns amber tint with a still amber square and amber time, and the fetched bar turns Muted. Under 760px stages stack as rows.
- **Crawl block:** a 30px tabular count, mono percentage, a 6px split bar (Carried Sage then green, both scaling from the left), a legend, and a mono pace line.
- **Tables:** per page type with mini bars beside the latest pages, joined on a rule; arriving rows flash `green-soft` and fade (1.4s). Paths dim their folder in Soft and keep the last segment in Ink 2.
- **Run chip:** on other views a mono top-bar link with the pulsing green square.

### Crawl garden
A pixel-rendered canvas (image-rendering pixelated, crosshair cursor) where each URL, or group of URLs, is a plant: leaf for served, wilt for empty HTML, error, stone for blocked, soil for waiting. Hovering shows a floating tooltip with the Pop shadow. A mono legend of 8px squares names the states. When the run finishes, the bed blooms once.

### Finished card
When a run completes the same card stays: a `green-soft` section with a 17px "Analysis finished" title, a sentence of what happened, and a row of delta chips on Surface (6px 12px). Each shows before → after in tabular Ink and a mono difference: red when a problem count rose, `green-ink` when it fell, Soft when unchanged. Chips pop in staggered by 70ms after 200ms.

### Ask home
A centred start: the pixel seedling, a 30px greeting, one square composer (min(660px, 100%)), suggestion chips (34px, Line Strong, a green leaf icon; hover lifts 2px with a green border and wash), then recent conversations as ruled rows with a drawn delete and inline confirm.
- **Composer:** Control Line border on Surface, a 15px auto-sizing textarea, a 38px square send in `primary` that scales 1.06 on hover and .94 on press; while answering it becomes an Ink stop square. Focus turns the border green with a 3px halo. Once a conversation starts the composer travels from centre to a sticky dock via a .38s view transition.
- **Question:** a right-aligned block in `primary` with `on-primary` text by day; on the raised Question step with a Line Strong border by night.
- **Answer:** 14px / 1.65 Ink 2 prose, max 62ch, square green list markers, 500 Ink for bold.
- **Status:** a mono Label line that breathes while working.

### Step trace with notes
A disclosure above each answer, summarised in mono Label, opening into rows on a 1px left rule: each step is a mono 11.5px row with a green check (red when failed, a pulsing square while running), its label in Ink 2 and a Soft summary. Short 13px Muted notes sit between steps. Steps and notes rise in (.28s).

### Insight tiles
Charts and tables an answer drew sit in a ruled tile: a 36px Surface 2 header strip in mono uppercase naming the kind (in `green-ink`) and the title (Ink 2), with chart/rows and fold actions on the right; the body below (18px) with an optional 12px Muted note. Folded tiles lose the strip's lower rule. Tables bleed to the tile's edges and scroll past 360px.

### Drawer
"Ask Eumon" in the top bar opens a 440px panel on the right on the page ground, with a 59px mono header, a drawn close, a Line rule on its left, and the Pop shadow; it slides in 24px over .32s. At 1440px and wider it pushes the page; on phones it is full width. Inside it the composer docks on a rule and the hint hides.

### Charts
Plain SVG and CSS from tool rows, in the series colours.
- **Bars:** label, a 10px Track with a Sprout fill, and a mono value, aligned on shared subgrid columns; bars grow from the left staggered 45ms. In a container under 440px the label sits over its bar.
- **Funnel:** the same rows in Sky, with the share kept from the previous step in Soft.
- **Heatmap:** page type × problem as a real table; each cell is tinted Red from 10% to 90% by the share of that page type affected, with the count in mono. Zero cells stay Surface; cells that don't apply are Surface 2 with a dash.
- **Scatter:** search position (1 left) against impressions; a Green Soft band marks positions 4–15. Points are 8px squares (Sprout, 10px, for queries near page one; Soft otherwise); hover or arrow keys read out each point.
- **Paired bars:** one row per section, one 8px bar per site on a shared scale (Sprout for you, then Sky, Clay, Sun), legend below.
- **Line:** up to three series (Sprout, Sun, Sky) at 2px, Line gridlines, mono ticks; the segment into today is dashed (3 4). The plot wipes in left to right (.9s). Hover or keyboard focus draws a Control Line cursor and a floating readout with series squares.

### Why rows
Every finding, opportunity, and insight is one 46px line: an optional severity or mark, the title (13.5px medium), an aside (impact, priority, CTR), and a green-ink mono "Why" with a chevron. It opens in place to the explanation and next step (13px Muted, max 76ch). Rows bleed to the card's edges and share rules. "Do first" is the same idea as three ranked buttons, each opening the tab that explains it.

### Inputs and navigation
- **Fields:** 38px, Control Line border on Surface, 13.5px text, Soft placeholder; label 13px 500 Ink 2 above, 12px Muted hint below.
- **Rail items:** 36px mono uppercase Muted; hover and active rise to Surface 2 with Ink text; a 6px square before each label fills green and rotates 45° when active. Step ranges sit right in Soft.
- **Tabs:** mono 12px uppercase; active is Ink with a 2px inset green underline on the shared rule.
- **Theme toggle:** three square icon buttons (device, light, dark) in a Surface 2 tray; the pressed one sits on Surface with a Line Strong inset rule.

### Motion
One curve, `cubic-bezier(.16, 1, .3, 1)`, for everything that moves. Views rise 6px in (.34s); toast, delta chips, and tooltip pop in from 12px below at .96 scale; questions, answers, steps, and tiles rise 8px in (.28-.4s); the drawer slides 24px in (.32s); progress fills scale from the left (.5-.6s); bars grow (.7s) and lines wipe in (.9s); counts tween (900ms). Presses scale to .97; chips lift 2px. Live state pulses: the green square (1.6s, rotating to a diamond) and the breathing status line. The theme swaps through a view-transition cross-fade.

Under `prefers-reduced-motion: reduce` every animation and transition collapses to .01ms and runs once, counts jump to their value, the theme swaps without a transition, and the composer's centre-to-dock transition is off.

### Icons
Drawn SVGs in `currentColor` at 1.4-1.8 stroke (check, cross, arrow up, stop, leaf, theme icons). The brand mark and seedling are pixel sprites with crisp edges.

## Do's and Don'ts

### Do:
- **Do** keep every corner square and every structural edge a 1px Line rule.
- **Do** let adjacent cards, cells, and stacked panels share a rule with a -1px overlap, and bleed rows and tables to the panel's edges.
- **Do** define every colour for both themes and reference roles, never theme values.
- **Do** use green for primary, progress, and positive state, and the Sprout, Sun, Sky, Clay series for data.
- **Do** set navigation, labels, table heads, counts, paths, and timings in Geist Mono uppercase; titles and prose in Geist at 400.
- **Do** run motion on `cubic-bezier(.16, 1, .3, 1)`, keep interaction under 300ms, and let every animation collapse under reduced motion.

### Don't:
- **Don't** round corners or put shadows on panels, cards, tiles, or controls; only the toast, tooltip, readout, and drawer float.
- **Don't** use pure black or pure white grounds.
- **Don't** use amber or red for anything but warnings and errors.
- **Don't** add illustration beyond the pixel sprites and the garden.
- **Don't** place a label above a view, card, or section heading.
- **Don't** use text glyphs as icons; draw them.
