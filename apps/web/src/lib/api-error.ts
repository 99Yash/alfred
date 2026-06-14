import { apiErrorMessage } from "@alfred/contracts";

export function responseErrorMessage(value: unknown, status: number, action: string): string {
  return apiErrorMessage(value, `${action} failed (${status})`);
}
