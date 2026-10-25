/**
 * URL-family identity templates (docs/plans/url-family-identity-templates.md). A template is
 * reviewed data that says where one sender family puts the identity of a thing in its links. A
 * back-test proves it on stored mail before it may link anything.
 *
 * A built-in kind keeps its `linkLabel` declarations: a label is order-free and matches a path
 * segment or a query parameter, so no whole-link pattern is equal to it. A template uses patterns.
 */

import { z } from "zod";
import { emailDomain, isDomainOrSubdomain } from "./domain";
import { parseEmailAddress } from "./guards";
import {
  collectLinkParts,
  identityAttributes,
  isLinkIdValue,
  OBJECT_STATE_CATEGORIES,
  objectIdentityDeclSchema,
  type LinkParts,
  type ObjectIdentityDecl,
} from "./integration-objects";

const SLOT_NAME_RE = /^[a-z][a-z0-9_]*$/;

const SLOT_PART_RE = /^\{([a-z][a-z0-9_]*)\}$/;

const slotNameSchema = z.string().regex(SLOT_NAME_RE);

const slotPartSchema = z.string().regex(SLOT_PART_RE);

const domainSchema = z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);

/** A literal segment, `{slot}`, `*` (one segment), or `**` (zero or more segments). */
const pathPartSchema = z
  .string()
  .min(1)
  .refine((part) => !part.includes("/") && (!part.includes("{") || SLOT_PART_RE.test(part)), {
    message: "a path part is a literal, `{slot}`, `*`, or `**`",
  });

export const linkPatternSchema = z.strictObject({
  /** A host or a parent domain. */
  hosts: z.array(domainSchema).min(1),
  /** Must match the whole path. */
  path: z.array(pathPartSchema).min(1),
  /** Parameter to `{slot}`. Every listed parameter is required. */
  query: z.record(z.string().min(1), slotPartSchema).optional(),
});

export type LinkPattern = z.infer<typeof linkPatternSchema>;

/** Add a scheme only with a family that needs it. */
export const slotDecodeSchema = z.strictObject({
  /** Base64url text, then the first run of six or more printable ASCII characters. */
  scheme: z.literal("base64url_printable_runs"),
  /** The first prefix that the value starts with is removed before the decode. */
  stripPrefix: z.array(z.string().min(1)).optional(),
  split: z.string().min(1),
  /** Names for the parts of the run, in order. */
  fields: z.array(slotNameSchema).min(1),
});

export type SlotDecode = z.infer<typeof slotDecodeSchema>;

/** Plain text, compared without case. Data written by a model holds no regular expression. */
const subjectMatchSchema = z.union([
  z.strictObject({ prefix: z.string().min(1) }),
  z.strictObject({ contains: z.string().min(1) }),
]);

export const urlFamilyEventSchema = z.strictObject({
  subject: subjectMatchSchema,
  state: z.enum(OBJECT_STATE_CATEGORIES),
  /** True when this event starts the life of an item. */
  opens: z.boolean().optional(),
});

export type UrlFamilyEvent = z.infer<typeof urlFamilyEventSchema>;

/** `once`: one item opens one time (an invoice). `recurring`: it can fail again (a CI run). */
export const URL_FAMILY_LIFECYCLES = ["once", "recurring"] as const;

export const urlFamilyTemplateSchema = z
  .strictObject({
    /** A built-in provider, or a connection-scoped provider key. */
    provider: z.string().min(1),
    kind: z.string().min(1),
    lifecycle: z.enum(URL_FAMILY_LIFECYCLES),
    /** Sender domains for the `about` reading. A subdomain also counts. */
    senders: z.array(domainSchema).min(1),
    links: z.array(linkPatternSchema).min(1),
    /** Slot to decode. The decoded fields become slots. */
    decode: z.record(slotNameSchema, slotDecodeSchema).optional(),
    /** Each attribute names a slot. Patterns place the values, so no attribute has a `linkLabel`. */
    identity: objectIdentityDeclSchema,
    /** Slots that never identify the item alone. Data for review and for the negative control. */
    containers: z.array(slotNameSchema),
    events: z.array(urlFamilyEventSchema).optional(),
  })
  .superRefine((template, ctx) => {
    const decodes = Object.entries(template.decode ?? {});
    const decoded = decodes.flatMap(([, spec]) => spec.fields);

    if (new Set(decoded).size !== decoded.length) {
      ctx.addIssue({ code: "custom", message: "two decodes name the same field" });
    }

    template.links.forEach((link, index) => {
      const bound = patternSlots(link);

      if (new Set(bound).size !== bound.length) {
        ctx.addIssue({ code: "custom", path: ["links", index], message: "a slot is bound twice" });
      }

      for (const [slot] of decodes) {
        if (!bound.includes(slot)) {
          ctx.addIssue({
            code: "custom",
            path: ["links", index],
            message: `the decoded slot \`${slot}\` is not bound`,
          });
        }
      }

      const slots = new Set([...bound, ...decoded]);

      if (decoded.some((field) => bound.includes(field))) {
        ctx.addIssue({
          code: "custom",
          path: ["links", index],
          message: "a decoded field has the name of a slot",
        });
      }

      for (const name of [...identitySlots(template.identity), ...template.containers]) {
        if (!slots.has(name)) {
          ctx.addIssue({
            code: "custom",
            path: ["links", index],
            message: `\`${name}\` is not a slot of this link`,
          });
        }
      }
    });

    if (identityAttributes(template.identity).some((a) => a.linkLabel !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["identity"], message: "a template has no linkLabel" });
    }

    if (identitySlots(template.identity).every((name) => template.containers.includes(name))) {
      ctx.addIssue({
        code: "custom",
        path: ["identity"],
        message: "the identity names only containers",
      });
    }
  });

export type UrlFamilyTemplate = z.infer<typeof urlFamilyTemplateSchema>;

function slotName(part: string): string | null {
  return SLOT_PART_RE.exec(part)?.[1] ?? null;
}

function patternSlots(link: LinkPattern): string[] {
  return [
    ...link.path.flatMap((part) => slotName(part) ?? []),
    ...Object.values(link.query ?? {}).flatMap((part) => slotName(part) ?? []),
  ];
}

function identitySlots(decl: ObjectIdentityDecl): string[] {
  return identityAttributes(decl).map((attribute) => attribute.attribute);
}

/** Every binding of `pattern` to `segments`. A `**` can give more than one. */
function pathBindings(
  pattern: readonly string[],
  segments: readonly string[],
  bound: Readonly<Record<string, string>> = {},
): Record<string, string>[] {
  const [head, ...rest] = pattern;

  if (head === undefined) return segments.length === 0 ? [{ ...bound }] : [];

  if (head === "**") {
    return segments
      .flatMap((_, index) => pathBindings(rest, segments.slice(index), bound))
      .concat(pathBindings(rest, [], bound));
  }

  const [segment, ...tail] = segments;

  if (segment === undefined) return [];

  if (head === "*") return pathBindings(rest, tail, bound);

  const slot = slotName(head);

  if (slot) {
    return isLinkIdValue(segment) ? pathBindings(rest, tail, { ...bound, [slot]: segment }) : [];
  }

  return segment === head ? pathBindings(rest, tail, bound) : [];
}

function sameBinding(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) {
  return Object.keys(a).every((key) => a[key] === b[key]);
}

const PRINTABLE_RUN_RE = /[\x20-\x7e]{6,}/;

/** The decoded fields of one slot value, or `null` when the value does not decode. */
function decodeSlot(spec: SlotDecode, value: string): Record<string, string> | null {
  const prefix = spec.stripPrefix?.find((candidate) => value.startsWith(candidate));
  const text = prefix ? value.slice(prefix.length) : value;

  if (!isLinkIdValue(text) || text.length % 4 === 1) return null;

  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  let bytes: string;

  try {
    bytes = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  } catch {
    return null;
  }

  const parts = PRINTABLE_RUN_RE.exec(bytes)?.[0].split(spec.split) ?? [];
  const fields: Record<string, string> = {};

  for (const [index, field] of spec.fields.entries()) {
    const part = parts[index];

    if (!part) return null;
    fields[field] = part;
  }

  return fields;
}

/**
 * The slots one link fills, from the first pattern it matches. `null` when it matches none. A
 * pattern whose path binds two ways, or whose parameter holds two values, does not match.
 */
function matchLink(template: UrlFamilyTemplate, link: LinkParts): Record<string, string> | null {
  for (const pattern of template.links) {
    if (!pattern.hosts.some((host) => isDomainOrSubdomain(link.host, host))) continue;

    const [binding, ...others] = pathBindings(pattern.path, link.segments);

    if (!binding || others.some((other) => !sameBinding(binding, other))) continue;

    const slots = { ...binding };
    let matched = true;

    for (const [parameter, part] of Object.entries(pattern.query ?? {})) {
      const values = new Set(link.query.filter(([name]) => name === parameter).map(([, v]) => v));
      const [value] = values;
      const slot = slotName(part);

      if (values.size !== 1 || value === undefined || !isLinkIdValue(value) || !slot) {
        matched = false;
        break;
      }

      slots[slot] = value;
    }

    for (const [slot, spec] of Object.entries(template.decode ?? {})) {
      if (!matched) break;

      const value = slots[slot];
      const fields = value === undefined ? null : decodeSlot(spec, value);

      if (fields) Object.assign(slots, fields);
      else matched = false;
    }

    if (matched) return slots;
  }

  return null;
}

/** True when the link is on a host of the template, whether or not a pattern matches it. */
export function isUrlFamilyHost(template: UrlFamilyTemplate, link: LinkParts): boolean {
  return template.links.some((pattern) =>
    pattern.hosts.some((host) => isDomainOrSubdomain(link.host, host)),
  );
}

/**
 * The identity key one link names, in declared order. `null` when the link fills no key. Values
 * from two links never combine into one key.
 */
export function urlFamilyLinkKey(
  template: UrlFamilyTemplate,
  link: LinkParts,
): readonly string[] | null {
  const slots = matchLink(template, link);

  if (!slots) return null;

  const key: string[] = [];

  for (const name of identitySlots(template.identity)) {
    const value = slots[name];

    if (value === undefined) return null;
    key.push(value);
  }

  return key;
}

/** The distinct keys that the links of a text name, in order. */
export function urlFamilyKeys(template: UrlFamilyTemplate, text: string): (readonly string[])[] {
  const keys = new Map<string, readonly string[]>();

  for (const link of collectLinkParts(text)) {
    const key = urlFamilyLinkKey(template, link);

    if (key) keys.set(key.join("\u0000"), key);
  }

  return [...keys.values()];
}

/** True when a mail from `from` comes from a sender domain of the template. */
export function isUrlFamilySender(template: UrlFamilyTemplate, from: string | null): boolean {
  const domain = emailDomain(parseEmailAddress(from));

  return domain !== null && template.senders.some((base) => isDomainOrSubdomain(domain, base));
}

/** The first event whose subject match the mail subject satisfies, or `null`. */
export function urlFamilyEvent(
  template: UrlFamilyTemplate,
  subject: string | null,
): UrlFamilyEvent | null {
  const text = (subject ?? "").toLowerCase();

  return (
    template.events?.find(({ subject: match }) =>
      "prefix" in match
        ? text.startsWith(match.prefix.toLowerCase())
        : text.includes(match.contains.toLowerCase()),
    ) ?? null
  );
}

/** The same template with the containers as its identity, for the negative control. */
export function containerControl(template: UrlFamilyTemplate): UrlFamilyTemplate | null {
  const [first, second, ...rest] = template.containers.map((attribute) => ({ attribute }));

  if (!first) return null;

  return {
    ...template,
    lifecycle: "once",
    identity: second ? { tuple: [first, second, ...rest] } : { uniqueKey: first },
    containers: [],
  };
}
