---
name: Eumon
description: Operator console for running client sites through the organic growth pipeline.
colors:
  bg: "#000000"
  surface: "#0a0a0a"
  surface-2: "#121212"
  ink: "#fafafa"
  ink-2: "#d4d4d4"
  muted: "#a1a1a1"
  soft: "#7c7c7c"
  line: "rgba(255, 255, 255, .1)"
  line-strong: "rgba(255, 255, 255, .18)"
  green: "#2eb885"
  green-hover: "#3fd197"
  amber: "#f5a524"
  amber-tint: "rgba(245, 165, 36, .12)"
  amber-ink: "#f7c46c"
  red: "#f26d6d"
  red-tint: "rgba(242, 109, 109, .12)"
  red-ink: "#f59a9a"
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
  xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.bg}"
    rounded: "{rounded.none}"
    padding: "0 14px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.green-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0 14px"
    height: "34px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-2}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "0 8px"
    height: "34px"
  button-small:
    padding: "0 10px"
    height: "28px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "8px 10px"
    height: "36px"
  card:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.none}"
    padding: "20px 22px"
  badge:
    backgroundColor: "rgba(255, 255, 255, .05)"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 8px"
    height: "22px"
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
    padding: "0 10px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
  progress:
    backgroundColor: "rgba(255, 255, 255, .08)"
    height: "4px"
---

# Design System: Eumon

## Overview

**Creative North Star: "The Ruled Console"**

A working console in Better Auth's world, pinned by the user: pure black ground, near-white ink, a few fixed grays, and every surface drawn with a 1px hairline at 10% white. Nothing is rounded, nothing floats. Panels do not sit on the page as cards; they share their rules with their neighbours, so the screen reads as one ruled sheet divided into cells. The work column is framed by full-height hairlines, and small + registration marks sit where those verticals cross the top-bar rule.

Colour is spent, not spread. Green is the brand and marks only what moves a client site forward: the primary action, the active place in the navigation, and progress. Amber and red exist only to say something is wrong. Everything else is grayscale, and hierarchy comes from type size, weight, and the shift between Geist and Geist Mono.

The system is dark only. It refuses the category default of soft white cards, rounded corners, and mint tints.

**Key Characteristics:**
- Black ground, hairline rules, zero radius everywhere.
- Geist regular for titles and prose; Geist Mono uppercase for the machinery (navigation, labels, table heads, codes, counts).
- Green on four things only; amber and red only for warnings and errors.
- Adjacent panels collapse onto a shared 1px rule.
- The ruled frame with + registration marks is the signature.

## Colors

A grayscale console with one spent accent and two alarm colors.

### Primary
- **Console Jade** (`green`): fill of the primary button (with black text), the 6px square beside the active navigation item, the progress fill, and the square brand mark. Hover lifts to **Lit Jade** (`green-hover`).

### Neutral
- **Pure Black** (`bg`): the page, the rail, cards, panels, and input fields. Surfaces are black; separation comes from rules.
- **Inset Black** (`surface`): table heads, code blocks, callouts, evidence and advantage boxes, row hover. The one step up from the ground, used for content that is quoted or set apart.
- **Raised Black** (`surface-2`): hover and active backgrounds for navigation and secondary buttons; the flash toast.
- **Paper White** (`ink`): headings, primary text, active states.
- **Quiet White** (`ink-2`): table cell text, code, list prose that should read softer than headings.
- **Graphite** (`muted`): ledes, card subtitles, secondary prose, inactive navigation.
- **Ash** (`soft`): mono labels, table heads, placeholders, captions, the footer.
- **Hairline** (`line`): every structural border and divider.
- **Strong Hairline** (`line-strong`): borders on interactive controls (inputs, secondary buttons, chips) and dashed empty states.

### Signal
- **Warning Amber** (`amber`, `amber-tint`, `amber-ink`): warning callouts, queued/draft/pending badges, sitemap notes, high-severity findings (tinted fill) and medium-severity findings (a 35% amber outline, no fill). Never a solid block.
- **Error Red** (`red`, `red-tint`, `red-ink`): error callouts, failed/blocked badges, failed checks, danger buttons, bad counts, critical findings.

### Named Rules
**The Spent Green Rule.** Green appears on the primary button, the active navigation marker, progress, and the brand mark. Nowhere else. Status words that mean "good" (published, live, approved) render as a neutral badge with ink text and a strong hairline, not green.

**The Alarm-Only Rule.** Amber and red carry warnings and errors and nothing else. They are never decoration, emphasis, or category color.

**The Dark-Only Rule.** There is no light theme. `color-scheme: dark` is set on the root.

## Typography

**Display Font:** Geist (with ui-sans-serif, system-ui)
**Label/Mono Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo)

**Character:** Geist at regular weight gives large titles a calm, engineered voice; Geist Mono in small uppercase with wide tracking marks everything that is system rather than prose. Weights stay at 400 and 500; 600 is reserved for the brand mark.

### Hierarchy
- **Display** (400, 44px, 1.08, -.03em; 32px under 760px): the first-run welcome title only.
- **Headline** (400, 36px, 1.1, -.025em; 28px under 760px): the one title per view, with a Graphite lede below it (14px, 1.6, max 640px).
- **Figure** (400, 28px, -.02em, tabular): KPI values.
- **Title** (500, 16px, -.01em): card and panel headings. Row headings inside panels drop to 13-14px at 500.
- **Body** (400, 14px, 1.5): base text. Secondary prose runs at 13px (1.55) or 12.5px in dense panels.
- **Label** (Mono 400, 11px, .1em, uppercase, Ash): field labels, KPI labels, table heads, section titles inside cards.
- **Nav** (Mono 400, 12px, .08em, uppercase): rail items, tabs (.06em), breadcrumb (.04em, not uppercase), the wordmark (13px, 500, .14em).
- **Code** (Mono 12.5px, 1.6): code blocks, inline mono values, snippets.

### Named Rules
**The Mono-for-Machinery Rule.** If it is navigation, a field name, a column head, a count, a code, or a URL path, it is Geist Mono. If it is a title or a sentence, it is Geist.

**The Regular-Weight Rule.** Large titles are 400, never bold. Emphasis inside panels uses 500 at body sizes.

**The Tabular Rule.** Numbers in KPIs, tables, scores, and counts use tabular figures and right alignment in tables.

## Layout

A fixed left rail (236px; 200px under 1050px) and a main area. The rail and the 59px top bar share one horizontal rule. The work column is centered, max 1190px wide (`calc(100% - 64px)`), padded 48px 40px 32px, and bounded left and right by full-height hairlines.

Grids are cells, not gaps: step cards, KPI grids (auto-fit, min 160px), and metric grids (4 columns, 2 under 760px) butt together with negative 1px margins so neighbours share a rule. The `split` layout pairs a wider and narrower column (1.15fr / .85fr) and collapses to one column under 900px, as do two-column forms (14px gap). Report panels below it stack in one column, each joined to the next on a shared rule, so a short panel never leaves a void beside a long one.

Spacing rhythm: 8px inside rows and controls, 14px between stacked callouts and form fields, 20-22px card padding, 28px below the view header, 48px top padding on the work column.

Under 760px the rail becomes a top strip: wordmark on its own line, navigation items wrap in a row, hostname label and site switcher hide; the top bar drops to 44px, the column loses its side rules (registration marks move inward to 12px), padding drops to 28px 16px, and wide tables scroll horizontally (min 560px).

## Elevation & Depth

Flat. Depth is conveyed by hairlines and one tonal step (`surface`, `surface-2`) above the black ground. The only shadow in the system is on the transient flash toast, which floats over content.

### Shadow Vocabulary
- **Toast lift** (`box-shadow: 0 12px 32px rgba(0, 0, 0, .6)`): the flash notice, bottom right. Nothing else.

### Named Rules
**The Flat Sheet Rule.** Panels, cards, and controls never cast shadows. If something needs to separate, give it a rule or the Inset Black surface.

## Shapes

Square. Every panel, card, button, input, select, badge, chip, tab, callout, and table has a 0 radius. Borders are 1px solid at Hairline for structure and Strong Hairline for controls; dashed Strong Hairline marks empty states and the add-website button. The only round shape is the loading spinner.

### Named Rules
**The Square Rule.** No radius, anywhere. A rounded corner is a sign the component came from a different system.

**The Registration Mark.** Where the work column's vertical rules meet the top bar's rule (and where the rail meets it), a 9px + drawn from two 1px Graphite lines marks the crossing. It belongs to the shell frame only.

## Components

### Buttons
Compact and literal; the label carries the action.
- **Shape:** square (0), 34px tall, 13px at 500 weight, 8px gap for an inline spinner.
- **Primary:** Console Jade fill, black text, 0 14px. One per view header at most; it is the forward action.
- **Hover:** primary lifts to Lit Jade; transitions on background, border, and color at .15s.
- **Secondary:** transparent, Paper White text, Strong Hairline border; hover raises to `surface-2` with a 40% white border.
- **Ghost:** text with an underline in Strong Hairline (offset 3px) that turns Paper White on hover. Used for inline actions inside empty states and callouts.
- **Danger:** Error Red text, no fill.
- **Small:** 28px tall, 0 10px, 12px text. Disabled buttons drop to 45% opacity.

### Badges and Chips
- **Badge:** 22px, mono 11px, Hairline border on a 5% white fill, Graphite text. Positive statuses use Paper White text on a Strong Hairline border; warnings and errors use the amber or red tint with a 30% border.
- **Chip:** 1px Strong Hairline border, 4px 8px, 12px Quiet White text. Used for field keys, markets, queries, source kinds.
- **Count pill:** mono 11px Graphite in a Hairline box, beside panel headings.

### Cards / Containers
- **Corner Style:** square (0).
- **Background:** Pure Black, same as the page.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px Hairline. Stacked or adjacent cards overlap by 1px so they share one rule.
- **Internal Padding:** 20px 22px for cards, 18px for panels (16px and 14px under 760px).
- **Header:** 16px title at 500 with a 13px Graphite subtitle; actions align right.

### Inputs / Fields
- **Style:** Pure Black field, Strong Hairline border, 36px tall, 13.5px text, Ash placeholder. Textareas start at 76px and resize vertically.
- **Label:** mono uppercase Label above the control, 6px gap; hint text 12px Graphite below.
- **Focus:** the border turns Paper White. The focus outline (1px Paper White, offset 2px), the caret, and text selection (Paper White with black text) match, so green stays on its four places.

### Navigation
- **Rail items:** 36px, mono 12px uppercase at .08em, Graphite text, no border. A 6px square sits before each label: transparent at rest, Console Jade when active. Hover and active raise the item to `surface-2` with Paper White text. The pipeline steps each view covers sit at the right in 11px Ash.
- **Tabs:** mono 12px uppercase, Graphite; active is Paper White with a 1px inset Paper White underline on the shared Hairline.
- **Breadcrumb:** mono 12px Graphite with an Ash slash, in the top bar.

### Icons
Drawn, never typed: 10px SVG at a 1.4 stroke in `currentColor` (`CheckIcon`, `CrossIcon` in `ui.tsx`). Text glyphs such as ✓, ✕, and × never stand in for an icon; a multiplication sign inside data ("By country × procedure") is typography, not an icon.

### Status blocks
- **Callout:** Inset Black with a Hairline border, 12px 14px, 13.5px Quiet White. Warning and error variants use the amber or red tint, a 30% border, and the matching ink color.
- **Empty state:** dashed Strong Hairline box, 28px padding, centered Graphite text, often with a ghost action.
- **Progress:** a 4px square track at 8% white with a Console Jade fill that scales from the left (.4s, cubic-bezier(.16, 1, .3, 1)).

### Data
- **Table:** inside a Hairline frame that scrolls horizontally; Inset Black head row with mono Label text; 10px 12px cells at 13px Quiet White; Hairline row dividers; row hover to Inset Black; numeric columns right-aligned and tabular.
- **KPI:** a ruled cell, 16px padding, mono Label, 28px regular Figure, 12px Graphite caption.
- **Code block:** Inset Black, Hairline border, mono 12.5px, scrolls past 340px.

### The Ruled Frame (signature)
The shell itself: rail rule, top-bar rule, and the work column's two full-height verticals, joined by + registration marks. New views live inside this frame and never draw their own outer frame.

## Do's and Don'ts

### Do:
- **Do** keep every surface black and separate panels with 1px Hairline rules (`rgba(255, 255, 255, .1)`).
- **Do** let adjacent cards, KPI cells, and grid cells share a rule with a -1px overlap.
- **Do** set navigation, field labels, table heads, and counts in Geist Mono uppercase; set titles and prose in Geist at 400.
- **Do** give each view one 36px regular title, a Graphite lede, and at most one green primary action on the right.
- **Do** show warnings and errors as tinted amber or red blocks with a 30% border.

### Don't:
- **Don't** add a light theme.
- **Don't** use green outside the primary button, the active navigation marker, progress, and the brand mark; positive status badges stay neutral.
- **Don't** use amber or red for anything but warnings and errors.
- **Don't** round any corner or add shadows to panels, cards, or controls.
- **Don't** use soft white cards, rounded corners, or mint tints.
- **Don't** place a label above a view or card title, or above a block of content. Lead with an inline phrase instead ("**Your advantage.** …", "Highest-impact opportunity: …").
- **Don't** use text glyphs as icons; draw them (see Icons).
