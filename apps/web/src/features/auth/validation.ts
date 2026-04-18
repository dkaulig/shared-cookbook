/**
 * Tiny, framework-free validation helpers — keep the forms free of an
 * extra schema dep for Phase 1. The server is the source of truth; these
 * only guard against obviously broken submissions.
 */
const EMAIL_REGEX =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export function isValidEmail(value: string): boolean {
  return EMAIL_REGEX.test(value)
}
