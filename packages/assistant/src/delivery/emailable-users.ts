import { db } from "@alfred/db";
import { user as userTable } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";

/**
 * Users with a verified email: the only ones a recurring send may reach.
 * Leftover test users once each drew paid briefings. Google sign-in marks real users verified.
 * Every recurring fan-out must use this, not only briefings.
 */
export async function selectEmailableUsers(): Promise<Array<{ id: string }>> {
  return db().select({ id: userTable.id }).from(userTable).where(eq(userTable.emailVerified, true));
}
