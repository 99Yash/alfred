import type { ContactSource } from "@alfred/contracts";
import { z } from "zod";
import type { RetryPolicy } from "../shared/retry";
import { googleJson } from "./http";

/**
 * People v1 reads over two collections: saved contacts (`contacts.readonly`) and
 * "Other contacts" (`contacts.other.readonly`).
 * Callers pass a token from `getFreshAccessToken(credentialId)`.
 */

const API_BASE = "https://people.googleapis.com/v1";

interface SourceApi {
  readonly searchPath: string;
  readonly listPath: string;
  readonly fields: string;
  readonly listMaskParam: "personFields" | "readMask";
}

/** Where each source lives. Other contacts accept only names, emails, and phones. */
const SOURCE_API = {
  saved: {
    searchPath: "people:searchContacts",
    listPath: "people/me/connections",
    fields: "names,emailAddresses,phoneNumbers,organizations",
    /** `connections.list` calls the mask `personFields`; the other three calls say `readMask`. */
    listMaskParam: "personFields",
  },
  other: {
    searchPath: "otherContacts:search",
    listPath: "otherContacts",
    fields: "names,emailAddresses,phoneNumbers",
    listMaskParam: "readMask",
  },
} as const satisfies Record<ContactSource, SourceApi>;

const DETAIL_FIELDS = [
  "names",
  "nicknames",
  "emailAddresses",
  "phoneNumbers",
  "organizations",
  "addresses",
  "birthdays",
  "biographies",
  "urls",
  "relations",
  "events",
].join(",");

const valueSchema = z.object({ value: z.string().optional() });

const dateSchema = z.object({
  year: z.number().optional(),
  month: z.number().optional(),
  day: z.number().optional(),
});

const personSchema = z.object({
  resourceName: z.string(),
  names: z.array(z.object({ displayName: z.string().optional() })).optional(),
  nicknames: z.array(valueSchema).optional(),
  emailAddresses: z.array(valueSchema).optional(),
  phoneNumbers: z.array(valueSchema).optional(),
  organizations: z
    .array(z.object({ name: z.string().optional(), title: z.string().optional() }))
    .optional(),
  addresses: z.array(z.object({ formattedValue: z.string().optional() })).optional(),
  birthdays: z
    .array(z.object({ date: dateSchema.optional(), text: z.string().optional() }))
    .optional(),
  biographies: z.array(valueSchema).optional(),
  urls: z.array(valueSchema).optional(),
  relations: z
    .array(z.object({ person: z.string().optional(), type: z.string().optional() }))
    .optional(),
  events: z
    .array(z.object({ date: dateSchema.optional(), type: z.string().optional() }))
    .optional(),
});

type Person = z.infer<typeof personSchema>;

const searchResponseSchema = z.object({
  results: z.array(z.object({ person: personSchema })).optional(),
});

/** `connections.list` answers `connections` + `totalPeople`; `otherContacts.list` answers `otherContacts`. */
const listResponseSchema = z.object({
  connections: z.array(personSchema).optional(),
  otherContacts: z.array(personSchema).optional(),
  nextPageToken: z.string().optional(),
  totalPeople: z.number().optional(),
});

export interface ContactSummary {
  resourceName: string;
  source: ContactSource;
  name?: string | undefined;
  emails: string[];
  phones: string[];
  organization?: string | undefined;
}

export interface ContactDetail extends ContactSummary {
  nicknames: string[];
  addresses: string[];
  birthday?: string | undefined;
  notes?: string | undefined;
  urls: string[];
  relations: Array<{ person: string; type?: string | undefined }>;
  events: Array<{ date: string; type?: string | undefined }>;
}

function presentValues(
  entries: ReadonlyArray<{ value?: string | undefined }> | undefined,
): string[] {
  return (entries ?? []).flatMap((entry) => (entry.value ? [entry.value] : []));
}

/** `--MM-DD` when the year is unknown, the form Google itself uses. */
function formatPeopleDate(date: z.infer<typeof dateSchema> | undefined): string | undefined {
  if (date?.month === undefined || date.day === undefined) return undefined;
  const mmdd = `${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

  return date.year === undefined ? `--${mmdd}` : `${String(date.year).padStart(4, "0")}-${mmdd}`;
}

function toSummary(person: Person, source: ContactSource): ContactSummary {
  const organization = person.organizations?.[0];
  const orgLine = [organization?.title, organization?.name].filter(Boolean).join(", ");

  return {
    resourceName: person.resourceName,
    source,
    name: person.names?.[0]?.displayName,
    emails: presentValues(person.emailAddresses),
    phones: presentValues(person.phoneNumbers),
    ...(orgLine ? { organization: orgLine } : {}),
  };
}

export interface SearchContactsArgs {
  accessToken: string;
  query: string;
  source: ContactSource;
  pageSize: number;
}

/**
 * Google answers a search from a cache that only an empty-query request refreshes,
 * so each search sends that warmup first (People API, `people.searchContacts`).
 */
export async function searchContacts(
  args: SearchContactsArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<ContactSummary[]> {
  const { searchPath, fields } = SOURCE_API[args.source];

  const urlFor = (query: string, pageSize: number) =>
    `${API_BASE}/${searchPath}?${new URLSearchParams({ query, readMask: fields, pageSize: String(pageSize) }).toString()}`;

  await googleJson("people", searchResponseSchema, {
    url: urlFor("", 1),
    accessToken: args.accessToken,
    retry,
  });

  const parsed = await googleJson("people", searchResponseSchema, {
    url: urlFor(args.query, args.pageSize),
    accessToken: args.accessToken,
    retry,
  });

  return (parsed.results ?? []).map((result) => toSummary(result.person, args.source));
}

export interface ListContactsArgs {
  accessToken: string;
  source: ContactSource;
  pageSize: number;
  pageToken?: string | undefined;
}

export interface ListContactsResult {
  contacts: ContactSummary[];
  nextPageToken?: string | undefined;
  /** Saved contacts only. */
  total?: number | undefined;
}

export async function listContacts(
  args: ListContactsArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<ListContactsResult> {
  const { listPath, fields, listMaskParam } = SOURCE_API[args.source];

  const params = new URLSearchParams({
    pageSize: String(args.pageSize),
    [listMaskParam]: fields,
    ...(args.pageToken !== undefined ? { pageToken: args.pageToken } : {}),
    ...(args.source === "saved" ? { sortOrder: "LAST_MODIFIED_DESCENDING" } : {}),
  });

  const parsed = await googleJson("people", listResponseSchema, {
    url: `${API_BASE}/${listPath}?${params.toString()}`,
    accessToken: args.accessToken,
    retry,
  });

  return {
    contacts: (parsed.connections ?? parsed.otherContacts ?? []).map((person) =>
      toSummary(person, args.source),
    ),
    nextPageToken: parsed.nextPageToken,
    total: parsed.totalPeople,
  };
}

export interface GetContactArgs {
  accessToken: string;
  /** `people/c…`. Other contacts have no detail read. */
  resourceName: string;
}

export async function getContact(
  args: GetContactArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<ContactDetail> {
  const params = new URLSearchParams({ personFields: DETAIL_FIELDS });

  // The resource name keeps its `/`; the contract pins it to `people/c<digits>`.
  const person = await googleJson("people", personSchema, {
    url: `${API_BASE}/${args.resourceName}?${params.toString()}`,
    accessToken: args.accessToken,
    retry,
  });

  const birthday = person.birthdays?.[0];

  return {
    ...toSummary(person, "saved"),
    nicknames: presentValues(person.nicknames),
    addresses: (person.addresses ?? []).flatMap((a) =>
      a.formattedValue ? [a.formattedValue] : [],
    ),
    birthday: formatPeopleDate(birthday?.date) ?? birthday?.text,
    notes: person.biographies?.[0]?.value,
    urls: presentValues(person.urls),
    relations: (person.relations ?? []).flatMap((r) =>
      r.person ? [{ person: r.person, type: r.type }] : [],
    ),
    events: (person.events ?? []).flatMap((e) => {
      const date = formatPeopleDate(e.date);

      return date ? [{ date, type: e.type }] : [];
    }),
  };
}
