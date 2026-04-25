# UX1-RT — Rich-Text Zubereitung (Markdown toolbar on step editor)

**Slice:** UX1-RT
**Status:** planned
**Date:** 2026-04-18
**Depends on:** GM1 (landed).

## Why

User complaint on the live app: "kein richt text editor bei der zubereitung" — the recipe form's step rows are bare `<textarea>` elements, no formatting support. Users who want to emphasise words, mark a sub-step, or list sub-instructions have no way to do so.

**Key finding during planning:** the **display side** already renders Markdown-lite — `StepList.tsx` has a hand-rolled `renderInlineMarkdown` that handles `**bold**` and `*italic*`. Storage is already `RecipeStepDto.content: string` treated as Markdown. The missing piece is the **editor side** — users can type `**foo**` manually but there's no affordance that tells them so.

## Plan-level decision (documented deviation from the tracker's initial hint)

The GM1/BF1/AP1 progress tracker listed UX1-RT as "Tiptap editor for recipe steps". On closer inspection, Tiptap brings:
- `@tiptap/react`, `@tiptap/starter-kit`, a markdown extension — ~150 KB min-gzipped added to the bundle
- A contenteditable-based editor that has known mobile-IME edge cases (cursor jumps, emoji composition, Android Gboard quirks)
- A full DOM tree to handle alongside the existing `SortableStepRow` dnd-kit integration — non-trivial

For a family recipe app where the existing corpus already stores Markdown strings, this is overkill. Instead:

**Adopted approach: lightweight Markdown toolbar + preview toggle.**
- A small row of icon buttons above each step's textarea: **B** (bold), **_I_** (italic), **–** (unordered list), **1.** (ordered list).
- Buttons wrap the current selection in the corresponding Markdown syntax (`**selected**`, `*selected*`, `- ` prefix on selected lines, `1. 2. 3.` prefix on selected lines).
- Keyboard shortcuts: `Cmd/Ctrl+B`, `Cmd/Ctrl+I`.
- A "Vorschau" toggle per step flips the textarea to a read-only rendered preview using the **existing** `renderInlineMarkdown` helper.
- Storage format stays identical — `content: string` with Markdown syntax. **Zero migration.**
- Display side extended: `StepList.renderInlineMarkdown` already covers bold + italic; extend it to also render `- ` / `1. ` list prefixes as proper `<ul>` / `<ol>` within a step block. **Zero new dependencies.**

If a user later really wants WYSIWYG, they can ask for a v2 upgrade and we swap in Tiptap. For now, this is the minimum viable Rich-Text.

## Scope

### 1. Extract + extend the Markdown renderer

- Move `renderInlineMarkdown` out of `StepList.tsx` into a new `apps/web/src/features/recipes/markdownRenderer.tsx`.
- Extend to handle line-prefixed lists: lines starting with `- ` become `<ul><li>…</li></ul>`; lines starting with `1. ` (or `2. `, etc.) become `<ol><li>…</li></ol>`.
- Bold + italic logic stays inline within list items.
- Unit tests: `markdownRenderer.test.tsx` covering: plain text, bold-only, italic-only, bold+italic in one string, ul list, ol list, ul + inline formatting, text followed by a list, empty string, malformed `**` (unmatched asterisks — render literally).
- `StepList.tsx` imports from the new module, no behaviour change for plain content.

### 2. New `<StepMarkdownToolbar>` component

File: `apps/web/src/features/recipes/StepMarkdownToolbar.tsx`

Props:
```ts
{
  value: string
  onChange: (next: string) => void
  textareaRef: RefObject<HTMLTextAreaElement>
  onTogglePreview: () => void
  previewMode: boolean
}
```

Renders a horizontal row of 5 buttons + a right-aligned preview toggle:
- **B** (Lucide `Bold`), aria-label "Fett", shortcut `Cmd/Ctrl+B`
- **I** (Lucide `Italic`), aria-label "Kursiv", shortcut `Cmd/Ctrl+I`
- **List bullets** (Lucide `List`), aria-label "Aufzählung"
- **Ordered list** (Lucide `ListOrdered`), aria-label "Nummerierte Liste"
- **Auge / Stift** toggle (Lucide `Eye` / `Pencil`), aria-label "Vorschau" / "Bearbeiten"

Behaviour:
- Click bold/italic: wraps the current selection with `**`/`*`; if no selection, inserts `**Text**` / `*Text*` at cursor position with "Text" pre-selected.
- Click list: prefixes each selected line with `- ` / `1. `; re-numbers `1. 2. 3.` deterministically for ordered lists.
- Clicks and keyboard shortcuts both use a `insertMarkdownAroundSelection(textarea, before, after)` helper — unit-tested in isolation.
- Tests: user events for each button; assert textarea value + new selection range; assert aria-labels; assert preview toggle.

### 3. Integrate into `SortableStepRow` inside `RecipeFormPage.tsx`

- Add `<StepMarkdownToolbar>` above the existing step textarea.
- Add the `previewMode` state per step (local state, part of `StepRow`).
- When `previewMode === true`, render `<div>{renderInlineMarkdown(content)}</div>` instead of the textarea, preserving the same padding/border so the layout doesn't jump.
- The toolbar's "Aufzählung"/"Nummerierte Liste" buttons operate on whatever lines are currently selected (or the current caret line if no selection).
- Tests: update `RecipeFormPage.test.tsx` to cover a user clicking the toolbar bold button and confirming the textarea now contains `**…**`.

### 4. Keyboard shortcuts

- Local key handler on the focused textarea element (`onKeyDown`) — not a document-level listener. Prevents conflicts with browser defaults.
- `Cmd/Ctrl+B` / `Cmd/Ctrl+I` — bold / italic wrap.
- Tab / Shift-Tab do nothing special (default textarea behaviour — we don't hijack tab navigation).

### 5. Autofocus + accessibility

- Toolbar buttons are `type="button"` (not submit) — critical inside a `<form>`.
- Each button has an aria-label in German.
- Preview toggle uses `aria-pressed` to reflect state.
- Live-region announcement "Vorschau aktiviert" / "Bearbeiten aktiviert" when toggled (polite).

## Non-goals (explicit)

- No Tiptap, no ProseMirror, no contenteditable.
- No tables.
- No links (user can paste URLs as plain text; they render as plain text).
- No inline code blocks / syntax highlighting.
- No drag-and-drop image insertion (photos go elsewhere).
- No headings (H1/H2/H3) — not needed within a single cooking step.
- No syntax error highlighting for malformed Markdown — we render it literally so the user sees their own typo.

## Acceptance criteria

- All 474 .NET + 495 web + 32 shared tests stay green. Add ~10–15 new web tests for the toolbar + renderer + integration.
- `pnpm typecheck && pnpm build && pnpm lint && pnpm test --run` clean.
- In the recipe form: user can select text in a step textarea, click **B** → text wraps to `**selected**`. Same for italic. Cmd/Ctrl+B works. List button prefixes the current line with `- `. Preview toggle shows the rendered output. Storage format is unchanged (confirmed: save a recipe with `**bold**` syntax, re-open, still shows `**bold**` in the textarea when edit mode, renders bold in detail view).
- Detail-view `StepList` continues to render existing Markdown correctly (no regression).

## Anti-shortcut reminders

- TDD every step. Test-commit precedes feat-commit.
- No `expect(true).toBe(true)`, no `it.skip`, no `// TODO: later`.
- The textarea manipulation helper must be a pure function — taking `(value, selectionStart, selectionEnd, before, after)` and returning `{ nextValue, nextSelectionStart, nextSelectionEnd }`. Don't manipulate the DOM textarea directly inside the helper — return values + let the component apply them.
- Markdown renderer must handle malformed input (unclosed `**`) without crashing.
- Don't break the existing bold + italic tests in `StepList.test.tsx` — extract + re-import rather than rewriting from scratch.
- **Security:** the renderer must produce React elements only. Do not inject raw HTML strings into the DOM. Every Markdown span renders as an escaped React child.

## Dispatch notes

**Impl agent:**
- Read `RecipeFormPage.tsx`, `StepList.tsx`, and the existing `StepList.test.tsx` before writing anything.
- Work order: renderer extraction + extend → helper unit tests → toolbar component + tests → form integration + tests.
- Run gates after each chunk: `pnpm test && pnpm typecheck && pnpm build && pnpm lint`.
- Commit per step, Co-Authored-By footer.

**Reviewer agent:**
- Verify TDD order via git log.
- Confirm no new packages in `apps/web/package.json`.
- Test the keyboard shortcuts + aria behaviour.
- Verify the renderer produces React elements only (no raw HTML injection).

**Smoke:** skipped for this slice — orchestrator continues autonomously per user mandate.
