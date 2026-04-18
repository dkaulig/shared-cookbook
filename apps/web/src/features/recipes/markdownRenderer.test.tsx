import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { renderInlineMarkdown } from './markdownRenderer'

/**
 * Thin wrapper so every test can use plain-text matching / DOM queries
 * against the rendered React nodes returned by `renderInlineMarkdown`.
 */
function renderMd(src: string) {
  return render(<div data-testid="md">{renderInlineMarkdown(src)}</div>)
}

describe('renderInlineMarkdown', () => {
  it('renders plain text without any markup wrappers', () => {
    const { getByTestId } = renderMd('Kartoffeln schälen und kochen.')
    const root = getByTestId('md')
    expect(root.textContent).toBe('Kartoffeln schälen und kochen.')
    expect(root.querySelector('strong')).toBeNull()
    expect(root.querySelector('em')).toBeNull()
    expect(root.querySelector('ul')).toBeNull()
    expect(root.querySelector('ol')).toBeNull()
  })

  it('wraps **bold** runs in <strong>', () => {
    const { getByTestId } = renderMd('Schnitzel **dünn klopfen**.')
    const strong = getByTestId('md').querySelector('strong')
    expect(strong).not.toBeNull()
    expect(strong!.textContent).toBe('dünn klopfen')
  })

  it('wraps *italic* runs in <em>', () => {
    const { getByTestId } = renderMd('Mit *Muskat* abschmecken.')
    const em = getByTestId('md').querySelector('em')
    expect(em).not.toBeNull()
    expect(em!.textContent).toBe('Muskat')
  })

  it('handles bold and italic in the same string', () => {
    const { getByTestId } = renderMd('**Salz** und *Pfeffer*.')
    const root = getByTestId('md')
    expect(root.querySelector('strong')!.textContent).toBe('Salz')
    expect(root.querySelector('em')!.textContent).toBe('Pfeffer')
  })

  it('renders a single "- " line as a one-item <ul>', () => {
    const { getByTestId } = renderMd('- Zwiebeln fein hacken')
    const ul = getByTestId('md').querySelector('ul')
    expect(ul).not.toBeNull()
    const items = ul!.querySelectorAll('li')
    expect(items).toHaveLength(1)
    expect(items[0]!.textContent).toBe('Zwiebeln fein hacken')
  })

  it('groups consecutive "- " lines into one <ul>', () => {
    const { getByTestId } = renderMd('- A\n- B\n- C')
    const ul = getByTestId('md').querySelector('ul')
    expect(ul).not.toBeNull()
    const items = ul!.querySelectorAll('li')
    expect(items).toHaveLength(3)
    expect(items[0]!.textContent).toBe('A')
    expect(items[2]!.textContent).toBe('C')
  })

  it('renders ordered list lines ("1. ", "2. ") as a single <ol>', () => {
    const { getByTestId } = renderMd('1. erst\n2. dann\n3. zuletzt')
    const ol = getByTestId('md').querySelector('ol')
    expect(ol).not.toBeNull()
    const items = ol!.querySelectorAll('li')
    expect(items).toHaveLength(3)
    expect(items[1]!.textContent).toBe('dann')
  })

  it('supports inline bold/italic inside list items', () => {
    const { getByTestId } = renderMd('- Zwiebeln **fein** hacken\n- Mit *Salz* bestreuen')
    const ul = getByTestId('md').querySelector('ul')!
    expect(ul.querySelector('strong')!.textContent).toBe('fein')
    expect(ul.querySelector('em')!.textContent).toBe('Salz')
  })

  it('renders a paragraph followed by a list and keeps both', () => {
    const { getByTestId } = renderMd('Vorbereitung:\n- Mehl sieben\n- Eier trennen')
    const root = getByTestId('md')
    expect(root.textContent).toContain('Vorbereitung:')
    const ul = root.querySelector('ul')!
    expect(ul.querySelectorAll('li')).toHaveLength(2)
  })

  it('renders an empty string without crashing and emits no markup', () => {
    const { getByTestId } = renderMd('')
    const root = getByTestId('md')
    expect(root.textContent).toBe('')
    expect(root.querySelector('strong')).toBeNull()
    expect(root.querySelector('ul')).toBeNull()
  })

  it('renders malformed "**" (unclosed) literally instead of crashing', () => {
    const { getByTestId } = renderMd('Achtung **unfertig')
    const root = getByTestId('md')
    expect(root.textContent).toBe('Achtung **unfertig')
    expect(root.querySelector('strong')).toBeNull()
  })

  it('renders text lines interleaved with list segments', () => {
    const { getByTestId } = renderMd('Zuerst A\n- eins\n- zwei\nDann B')
    const root = getByTestId('md')
    expect(root.textContent).toContain('Zuerst A')
    expect(root.textContent).toContain('Dann B')
    const ul = root.querySelector('ul')!
    expect(ul.querySelectorAll('li')).toHaveLength(2)
  })
})
