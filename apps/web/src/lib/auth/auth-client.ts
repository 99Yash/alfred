import { createAuthClient } from "better-auth/react";
import { API_URL } from "~/lib/eden";

export const authClient = createAuthClient({
  baseURL: API_URL,
});
