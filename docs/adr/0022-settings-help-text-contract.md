# ADR-0022: Settings text is a heading plus a one-sentence "?" popover, not an inline paragraph

Every `configSchema` property renders as a heading and a control. The heading
is the JSON Schema `title` (falling back to the key split into words), and the
`description` is shown only in a "?" popover beside the heading — never as a
paragraph under it. A description is one short sentence (≤ 120 characters):
what the setting does, plus at most one operational hint. An empty description
means no popover. Titles are ≤ 40 characters, Title Case, no trailing stop.

The same `title` is the field's name everywhere it appears — the settings
form, array-item fields, the module context menu — so nothing else derives a
label from `description`.

The manifest is the single source of the text. Where a plugin copies a shared
schema block (subtitle overlay controls from `subtitle-core`), the copy must be
identical and a test pins it.

## Why

Operators read the panel on a 320 px column and on touch screens. Paragraphs of
tuning history under every heading pushed the controls off screen and hid the
one fact each setting needed. The popover keeps the knowledge one tap away
without paying for it on every render. Standard JSON Schema keywords are used
so no new `x-` extension was needed.

## Consequences

- `packages/manager/src/plugins/manifestHelpText.test.ts` enforces the caps and
  that settings shared across plugins (`playoutOffsetMs`, `pcmBitDepth`,
  `mixLatencyMs`) carry identical wording.
- Long-form tuning knowledge lives in git history and, where it is an operating
  rule, in the plugin's README — not in the manifest.
- Two tooltip idioms exist: `MrTooltip` (CSS hover, for chrome that never
  scrolls) and `MrHelpTip` (teleported, fixed, pinnable — for anything inside
  a scroll box or that touch users must reach). They share one bubble style.
