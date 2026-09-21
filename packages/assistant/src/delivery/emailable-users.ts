import { db } from "@alfred/db";
import { user as userTable } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";

/**
 * The users a recurring fan-out is allowed to send to.
 *
 * Scoped to a **verified** email, because a fan-out is where a bare `user` row
 * turns into paid LLM work and an outbound email. An unverified address is one
 * nobody has proven they control, so a recurring send must never go there.
 * Google social sign-in is the only way to create a real Alfred user and Better
 * Auth marks it verified from the provider's `email_verified` claim, so no real
 * user is excluded.
 *
 * This is defense in depth, not the primary fix: rows seeded by a test that
 * forgets to clean up (`user` carries no `test` flag to key on) were fanned out
 * to for real — 83 leftover `@example.test` users each drew an evening briefing
 * every hour, which alone exceeded the AI-gateway rate limit and billed real
 * tokens against addresses nobody owns. Tests own their cleanup; this predicate
 * makes the blast radius of a missed cleanup zero instead of unbounded.
 *
 * It lives beside {@link notify} rather than in the briefing that first needed
 * it, because the incident is a property of every recurring outbound send and
 * not of briefings. A second fan-out landed without this filter precisely
 * because the predicate read as briefing-specific.
 *
 * Exported as its own seam so the predicate is assertable against a real
 * database without standing up Redis and a BullMQ worker.
 */
export async function selectEmailableUsers(): Promise<Array<{ id: string }>> {
  return db().select({ id: userTable.id }).from(userTable).where(eq(userTable.emailVerified, true));
}
