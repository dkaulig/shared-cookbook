import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Textarea } from './textarea'

describe('<Textarea />', () => {
  it('renders a <textarea> with Sage Modern tokens', () => {
    render(<Textarea placeholder="Schritt beschreiben…" />)
    const textarea = screen.getByPlaceholderText('Schritt beschreiben…')
    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea.className).toMatch(/border-input/)
    expect(textarea.className).toMatch(/bg-background/)
    expect(textarea.className).toMatch(/text-base/)
  })

  it('uses vertical resize + min-h for multi-line content', () => {
    render(<Textarea placeholder="p" />)
    const textarea = screen.getByPlaceholderText('p')
    expect(textarea.className).toMatch(/resize-y/)
    expect(textarea.className).toMatch(/min-h-/)
  })

  it('carries the sage 4-ring focus state', () => {
    render(<Textarea placeholder="p" />)
    const textarea = screen.getByPlaceholderText('p')
    expect(textarea.className).toMatch(/focus-visible:ring-4/)
    expect(textarea.className).toMatch(/focus-visible:ring-ring/)
  })

  it('forwards className and rows attribute', () => {
    render(<Textarea className="custom-ta" rows={6} placeholder="p" />)
    const textarea = screen.getByPlaceholderText('p') as HTMLTextAreaElement
    expect(textarea.className).toMatch(/custom-ta/)
    expect(textarea.rows).toBe(6)
  })
})
