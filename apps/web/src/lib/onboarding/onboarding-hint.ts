import { getLocalStorageItem, LOCAL_STORAGE_KEY, setLocalStorageItem } from "~/lib/storage/storage";

/**
 * First-paint onboarding hint. The two keys are one value: write them together,
 * and check the user id before the flag. Not a security boundary.
 */

export function writeOnboardingHint(userId: string, complete: boolean): void {
  setLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_COMPLETE, complete);
  setLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_USER_ID, userId);
}

export function readOnboardingHint(userId: string | undefined): boolean {
  const storedId = getLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_USER_ID);

  if (userId && storedId !== userId) return false;

  return getLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_COMPLETE);
}

export function onboardingHintBelongsToAnotherUser(userId: string): boolean {
  return getLocalStorageItem(LOCAL_STORAGE_KEY.ONBOARDING_USER_ID) !== userId;
}
