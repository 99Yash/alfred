/**
 * A fully rendered email ready to hand to the transport: a subject plus both
 * MIME bodies. The canonical shape every "compose an email" helper returns
 * (briefing, skill-documentation, …), so callers don't each re-declare it.
 */
export interface ComposedEmail {
  subject: string;
  html: string;
  text: string;
}
