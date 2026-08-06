import { z } from "zod";

const senderEmailSchema = z.string().trim().toLowerCase().pipe(z.email());

export function normalizeSenderEmail(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  const angleAddress = raw.match(/<([^<>]+)>/)?.[1];
  const candidate = (angleAddress ?? raw).replace(/^mailto:/i, "").trim();
  const parsed = senderEmailSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
