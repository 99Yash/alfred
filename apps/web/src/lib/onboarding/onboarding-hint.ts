import { getLocalStorageItem, LOCAL_STORAGE_KEY, setLocalStorageItem } from "~/lib/storage/storage";

/**
 * First-paint onboarding hint — the two localStorage keys are one value.
 *
 * `ONBOARDING_COMPLETE` is only meaningful for the user in
 * `ONBOARDING_USER_ID`; a DB wipe followed by a fresh signup must not let the
 * old account's `true` keep the new account out of `/onboarding`. Every
 * writer therefore stores the pair together, and every reader checks the id
 * before trusting the boolean. A UX hint, never a security boundary — server
 * truth is `GET /api/me/onboarding`.
 */

export function writeOnboardingHint(userId: string, complete: boolean): void {
  setLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_COMPLETE, complete);
  setLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_USER_ID, userId);
}

/** `true` only when the stored hint says complete AND belongs to `userId`. */
export function readOnboardingHint(userId: string | undefined): boolean {
  const storedId = getLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_USER_ID);

  if (userId && storedId !== userId) return false;

  return getLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_COMPLETE);
}

/** Whether the stored hint was written for a different account than `userId`. */
export function onboardingHintBelongsToAnotherUser(userId: string): boolean {
  return getLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_USER_ID) !== userId;
}
