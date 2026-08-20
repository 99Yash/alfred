import { z } from "zod";

/** Providers that can own a row in the shared documents corpus. */
export const DOCUMENT_SOURCES = [
  "gmail",
  "gmail_attachment",
  "drive",
  "gcal",
  "slack",
  "linear",
  "github",
  "notion",
  "imessage",
] as const;

export const documentSourceSchema = z.enum(DOCUMENT_SOURCES);
export type DocumentSource = z.infer<typeof documentSourceSchema>;
