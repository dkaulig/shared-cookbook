/**
 * CR4 — three-dot bouncing typing indicator.
 *
 * Pure CSS via Tailwind's `animate-bounce` with staggered
 * `animation-delay` on each dot. No animation library, no JS state.
 *
 * Accessibility: `role="status"` + descriptive German aria-label so a
 * screen-reader announces "Antwort wird geschrieben..." once when the
 * indicator appears (assistive tech polite-region semantics handle the
 * rest — we don't want a per-frame re-announcement).
 */
export function TypingIndicator() {
  return (
    <div
      role="status"
      aria-label="Antwort wird geschrieben..."
      data-testid="chat-typing-indicator"
      className="flex items-center gap-1.5 px-1 py-2"
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--muted-foreground))] animate-bounce"
        style={{ animationDelay: '0ms' }}
        aria-hidden="true"
      />
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--muted-foreground))] animate-bounce"
        style={{ animationDelay: '150ms' }}
        aria-hidden="true"
      />
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--muted-foreground))] animate-bounce"
        style={{ animationDelay: '300ms' }}
        aria-hidden="true"
      />
    </div>
  )
}
