<!-- stardust:provenance writtenBy=stardust:extract writtenAt=2026-11-04T15:27:20.297Z readArtifacts=stardust/current/_brand-extraction.json,stardust/current/_computed-styles.json -->
---
name: Arco
description: Arco crafts espresso machines and grinders for people who care about every detail — from bean to cup.
colors:
  primary: "#B5651D"
  primary-hover: "#8E4E14"
  accent-secondary: "#D4883A"
  text: "#1C2B35"
  text-muted: "#5C6B73"
  background: "#F5F0E8"
  surface: "#FFFFFF"
  border: "#D4CFC5"
typography:
  display:
    fontFamily: "Inter, sans-serif"
    fontSize: "80px"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-1.6px"
  h2:
    fontFamily: "Inter, sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.15
  h3:
    fontFamily: "Inter, sans-serif"
    fontSize: "27px"
    fontWeight: 600
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    letterSpacing: "1.4px"
rounded:
  sm: "4px"
  md: "12px"
  pill: "100px"
spacing:
  xs: "8px"
  sm: "16px"
  md: "24px"
  lg: "32px"
  xl: "48px"
  xxl: "80px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
    padding: "10px 31px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
---

# Design System: Arco (current state)

## Overview
Arco presents premium home espresso equipment with a warm, editorial calm: a cream (`#F5F0E8`) canvas, deep slate-navy text (`#1C2B35`) and a single copper accent (`#B5651D`) that echoes the copper ring of the logo mark. Large, sunlit product photography carries the hero; white cards with soft shadows hold products and stories.

## Colors
### Primary
- **Copper** `#B5651D` — CTAs, links, price tags, active filter chips. Hover `#8E4E14`.
### Secondary
- **Amber** `#D4883A` — used only inside the copper→amber gradient bar (`linear-gradient(90deg, #B5651D, #D4883A)`).
### Neutral
- **Slate navy** `#1C2B35` text and headings; **muted slate** `#5C6B73` secondary text; **cream** `#F5F0E8` page background; **white** `#FFFFFF` cards; **sand** `#D4CFC5` borders.

## Typography
Inter for everything (Google Fonts, weights 400–800). Hero H1 80px/700 with tight negative tracking (-1.6px); H2 36px/600; H3 27px/600; body 18px/400; buttons and labels 14px/500 uppercase, 1.4px tracking. Scale is ad-hoc (80 → 44 → 36 → 27 → 19 → 18 → 16 → 14 → 11).

## Layout
Centered content column on a cream canvas, 80px sticky header. Product grids at 3 columns (desktop); PDP is a two-column image/details split with a specification table. Breakpoints 600 / 900 / 1200px.

## Elevation & Depth
Soft slate-tinted shadows: sm `0 1px 3px rgb(28 43 53 / 6%)`, md `0 4px 20px rgb(28 43 53 / 8%)`, lg `0 12px 40px rgb(28 43 53 / 12%)`, xl `0 20px 60px rgb(28 43 53 / 14%)`.

## Shapes
Cards and media 12px radius; buttons, chips and nav pills 100px (pill); avatars 50%.

## Components
### Buttons
Primary: copper fill, white uppercase label, pill. Secondary/ghost: transparent, sand 1px border, muted text, pill.
### Chips
Filter chips (All / Automatic / Commercial …): pill, sand border; active chip copper fill.
### Cards / Containers
White, 12px radius, shadow-sm; image top, category label in copper, title, price, "View Product" link.
### Navigation
Logo left, uppercase nav items with dropdown chevrons, search field ("Ask about coffee equipment…") and two small ghost pills right.

## Do's and Don'ts
### Do:
- Keep copper as the single action color on a cream/white ground.
- Lead with real, warm product photography.
### Don't:
- Introduce additional saturated hues or hard black shadows.
