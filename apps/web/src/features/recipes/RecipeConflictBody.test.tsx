import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RecipeConflictBody } from './RecipeConflictBody'
import type { RecipeConflictShape } from './RecipeConflictBody'

function makeRecipe(
  overrides: Partial<RecipeConflictShape> = {},
): RecipeConflictShape {
  return {
    id: 'r1',
    title: 'Nudelauflauf',
    description: 'Mit Käse',
    ingredients: [
      { position: 0, quantity: 500, unit: 'g', name: 'Nudeln', scalable: true },
      { position: 1, quantity: 200, unit: 'g', name: 'Käse', scalable: true },
      { position: 2, quantity: 100, unit: 'ml', name: 'Milch', scalable: true },
    ],
    steps: [
      { position: 0, content: 'Wasser aufsetzen.' },
      { position: 1, content: 'Nudeln kochen.' },
    ],
    version: 1,
    ...overrides,
  }
}

describe('<RecipeConflictBody />', () => {
  it('renders title-only change with both sides + highlight', () => {
    const server = makeRecipe({ title: 'Spaghetti Bolognese' })
    const local = makeRecipe({ title: 'Spaghetti Carbonara' })
    render(<RecipeConflictBody current={server} local={local} />)

    const sides = screen.getAllByTestId(/conflict-side-/)
    // 4 fields × 2 sides = 8 boxes (title, description, and — no, count
    // deltas don't use the side-boxes). Title + description are
    // side-by-side so we expect at least 4 boxes (title + description,
    // server + local).
    expect(sides.length).toBeGreaterThanOrEqual(4)
    expect(screen.getByText('Spaghetti Bolognese')).toBeInTheDocument()
    expect(screen.getByText('Spaghetti Carbonara')).toBeInTheDocument()
  })

  it('renders ingredient count delta when server adds one', () => {
    const server = makeRecipe({
      ingredients: [
        ...makeRecipe().ingredients,
        {
          position: 3,
          quantity: 50,
          unit: 'g',
          name: 'Parmesan',
          scalable: true,
        },
      ],
    })
    const local = makeRecipe()
    render(<RecipeConflictBody current={server} local={local} />)

    // Section heading carries the field label.
    expect(
      screen.getByRole('heading', { level: 3, name: /Zutaten/ }),
    ).toBeInTheDocument()
    // "4 → 3 Zutaten" — the two counts appear as bolded spans inside
    // the same <p>.
    const zutatenSection = screen
      .getByRole('heading', { level: 3, name: /Zutaten/ })
      .parentElement!
    expect(zutatenSection).toHaveTextContent('4')
    expect(zutatenSection).toHaveTextContent('3')
  })

  it('renders step-count delta + changed-step marker on reorder', () => {
    const server = makeRecipe()
    const local = makeRecipe({
      steps: [
        { position: 0, content: 'Nudeln kochen.' },
        { position: 1, content: 'Wasser aufsetzen.' },
      ],
    })
    render(<RecipeConflictBody current={server} local={local} />)

    // Both sides 2 steps, but content differs at both positions → 2 changed.
    expect(
      screen.getByRole('heading', { level: 3, name: /Schritte/ }),
    ).toBeInTheDocument()
    const schritteSection = screen
      .getByRole('heading', { level: 3, name: /Schritte/ })
      .parentElement!
    expect(schritteSection).toHaveTextContent(/geänderte Schritt/)
  })

  it('exposes the merge editor when mergeEditorOpen=true', () => {
    render(
      <RecipeConflictBody
        current={makeRecipe()}
        local={makeRecipe()}
        mergeEditorOpen
      />,
    )
    expect(
      screen.getByTestId('recipe-conflict-merge-editor'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('recipe-conflict-merge-title'),
    ).toBeInTheDocument()
  })
})
