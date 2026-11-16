import {
  correspondentHistorySchema,
  parseEmailIdentity,
  type CorrespondentHistory,
  type IanaTimezone,
} from "@alfred/contracts";
import { inZone } from "@alfred/assistant/time";
import { db, rowsFromExecute } from "@alfred/db";
import { observationFamilyHeads, observations } from "@alfred/db/schemas";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { liveObservationHeadJoin } from "./observations";

const PEOPLE_LIMIT = 20;

const correspondentRowSchema = correspondentHistorySchema.extend({
  documentId: z.string().nullable(),
});

interface MailCorrespondents {
  readonly documentId: string;
  readonly sentAt: Date;
  readonly addresses: readonly string[];
}

interface RequestedAddress {
  readonly address: string;
  readonly document_id: string | null;
  readonly sent_before: Date | null;
}

function requestedAddresses(
  addresses: readonly string[],
  mail?: MailCorrespondents,
): RequestedAddress[] {
  const values = new Set(addresses.flatMap((address) => parseEmailIdentity(address) ?? []));

  return [...values].map((address) => ({
    address,
    document_id: mail?.documentId ?? null,
    sent_before: mail?.sentAt ?? null,
  }));
}

type Selection =
  | { readonly addresses: readonly RequestedAddress[] }
  | { readonly query: string }
  | { readonly recent: true };

function selectAddresses(selection: Selection): SQL {
  if ("addresses" in selection) {
    return sql`
      select * from jsonb_to_recordset(${JSON.stringify(selection.addresses)}::jsonb)
        as wanted(address text, document_id text, sent_before timestamptz)`;
  }

  return sql`select distinct address, null::text as document_id, null::timestamptz as sent_before
    from mail_people`;
}

function restrictResults(selection: Selection): SQL {
  if ("addresses" in selection) return sql`order by history.document_id, history.address`;

  if ("recent" in selection) {
    return sql`where history.sent_count > 0
      order by history.last_sent_at desc, history.address limit ${PEOPLE_LIMIT}`;
  }

  return sql`order by history.last_seen_at desc nulls last, history.address`;
}

/** Use the same Unicode word boundaries for a question and a stored name or address. */
function wordsIn(text: string): string[] {
  return (
    text
      .normalize("NFC")
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  );
}

/** The live Gmail heads supply both the counts and their time window. */
async function readCorrespondentRows(userId: string, selection: Selection) {
  if ("addresses" in selection && selection.addresses.length === 0) return [];

  const result = await db().execute(sql`
    with gmail as materialized (
      select ${observations.id} as id, ${observations.occurredAt} as sent_at,
        ${observations.payload}->>'documentId' as document_id,
        ${observations.payload}->'isSent' = 'true'::jsonb as sent,
        ${observations.participants}->'items' as participants
      from ${observations}
      join ${observationFamilyHeads} on ${liveObservationHeadJoin()}
      where ${observations.userId} = ${userId}
        and ${observations.source} = 'gmail' and ${observations.kind} = 'email_message'
    ), mail_people as (
      -- One row per address per message, even if it is in both To and Cc.
      select gmail.id, gmail.sent_at, gmail.document_id, person->'identity'->>'value' as address,
        bool_or(not gmail.sent and person->>'role' = 'from') as received,
        bool_or(gmail.sent and person->>'role' in ('to', 'cc')) as sent,
        max(nullif(person->>'displayName', '')) filter (where person->>'role' = 'from') as from_name,
        max(nullif(person->>'displayName', '')) filter (
          where gmail.sent and person->>'role' in ('to', 'cc')
        ) as recipient_name
      from gmail
      cross join lateral jsonb_array_elements(gmail.participants) as participants(person)
      where person->'identity'->>'kind' = 'email'
      group by gmail.id, gmail.sent_at, gmail.document_id, person->'identity'->>'value'
    ), wanted as (
      ${selectAddresses(selection)}
    ), history as (
      select wanted.address, wanted.document_id, wanted.sent_before,
        coalesce(
          mode() within group (order by mail_people.from_name),
          mode() within group (order by mail_people.recipient_name)
        ) as display_name,
        min(mail_people.sent_at) as first_seen_at,
        max(mail_people.sent_at) as last_seen_at,
        count(*) filter (where mail_people.received)::int as received_count,
        max(mail_people.sent_at) filter (where mail_people.received) as last_received_at,
        count(*) filter (where mail_people.sent)::int as sent_count,
        max(mail_people.sent_at) filter (where mail_people.sent) as last_sent_at
      from wanted
      left join mail_people on mail_people.address = wanted.address
        and (wanted.document_id is null or mail_people.document_id is distinct from wanted.document_id)
        and (wanted.sent_before is null or mail_people.sent_at < wanted.sent_before)
      group by wanted.address, wanted.document_id, wanted.sent_before
    ), coverage as (
      select min(sent_at) as started_at from gmail
    )
    select history.address, history.document_id as "documentId", history.display_name as "displayName",
      history.first_seen_at as "firstSeenAt", history.last_seen_at as "lastSeenAt",
      history.received_count as "receivedCount", history.last_received_at as "lastReceivedAt",
      history.sent_count as "sentCount", history.last_sent_at as "lastSentAt",
      case when history.sent_before is null or coverage.started_at <= history.sent_before
        then coverage.started_at end as "windowStartedAt"
    from history cross join coverage
    ${restrictResults(selection)}
  `);

  return rowsFromExecute(result, correspondentRowSchema);
}

/** Exact addresses, query matches, or the addresses the user wrote to most recently. */
export async function readCorrespondents(
  userId: string,
  addresses: readonly string[] | { readonly query: string } | { readonly recent: true },
): Promise<CorrespondentHistory[]> {
  const selection =
    "query" in addresses || "recent" in addresses
      ? addresses
      : { addresses: requestedAddresses(addresses) };

  const words = "query" in selection ? new Set(wordsIn(selection.query)) : null;

  if (words?.size === 0) return [];

  const rows = await readCorrespondentRows(userId, selection);

  const histories = words
    ? rows
        .filter((row) =>
          wordsIn(`${row.displayName ?? ""} ${row.address}`).some((word) => words.has(word)),
        )
        .slice(0, PEOPLE_LIMIT)
    : rows;

  return histories.map(({ documentId: _documentId, ...history }) => history);
}

/** Mail history before each message, all in one read. The current message is never evidence. */
export async function readMailCorrespondents(
  userId: string,
  mails: readonly MailCorrespondents[],
): Promise<ReadonlyMap<string, ReadonlyMap<string, CorrespondentHistory>>> {
  const rows = await readCorrespondentRows(userId, {
    addresses: mails.flatMap((mail) => requestedAddresses(mail.addresses, mail)),
  });

  const byDocument = new Map<string, Map<string, CorrespondentHistory>>();

  for (const { documentId, ...history } of rows) {
    if (documentId === null) continue;
    const byAddress = byDocument.get(documentId) ?? new Map();
    byAddress.set(history.address, history);
    byDocument.set(documentId, byAddress);
  }

  return byDocument;
}

/** State the window so zero counts cannot imply that the user never wrote to an address. */
export function describeCorrespondentHistory(
  history: CorrespondentHistory,
  timezone: IanaTimezone,
): string {
  if (history.windowStartedAt === null) return "no stored mail history for this time";

  const zone = inZone(timezone);
  const window = zone.day(history.windowStartedAt);
  const sent = history.lastSentAt ? `, last ${zone.day(history.lastSentAt)}` : "";
  const received = history.lastReceivedAt ? `, last ${zone.day(history.lastReceivedAt)}` : "";

  return `stored mail since ${window}: you sent ${history.sentCount}${sent}; they sent ${history.receivedCount}${received}`;
}
