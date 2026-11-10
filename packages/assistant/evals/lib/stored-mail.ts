import { readMailFacts, type MailFacts } from "@alfred/integrations/google";

/**
 * The mail facts that prod reads from `documents.raw`, built from an eval case through the same
 * reader. Real mail carries a To line, so it defaults to the user; a case sets `To: ""` to drop it.
 */
export function evalMailFacts(args: {
  from: string;
  to: string;
  labelIds: readonly string[];
  headers?: Readonly<Record<string, string>> | undefined;
}): MailFacts {
  const headers = { From: args.from, To: args.to, ...args.headers };

  return readMailFacts({
    id: "eval",
    threadId: "eval",
    labelIds: [...args.labelIds],
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  });
}
