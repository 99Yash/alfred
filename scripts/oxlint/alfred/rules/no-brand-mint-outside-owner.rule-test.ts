import { RuleTester } from "oxlint/plugins-dev";

import { noBrandMintOutsideOwnerRule } from "./no-brand-mint-outside-owner.ts";

// The spec of `no-brand-mint-outside-owner`: a type guard or a `z.custom` schema of a
// `unique symbol` brand lives in the brand's owner module. Both mint the brand with no
// cast, so a doc that said "only `foo()` mints it" was false (#1540, #1548). See
// docs/reference/smells/brand-claim-needs-probe.md.
//
// `pnpm check:oxlint-plugin` drives each `invalid` case through the root
// `.oxlintrc.json`. A bare `filename` such as `probe.ts` names only the language
// and keeps the case inside the gate scope, outside every owner. A case with a
// repo path is an owner case and runs here only.

const tester = new RuleTester();

const mint = (form: string, brand: string, owner: string) => ({
  messageId: "mintOutsideOwner",
  data: { form, brand, owner },
});

const briefing = "packages/contracts/src/briefing.ts";

const localTime = "packages/assistant/src/time/local-time.ts";

const toolRuntime = "packages/assistant/src/tool-runtime/index.ts";

tester.run("alfred/no-brand-mint-outside-owner", noBrandMintOutsideOwnerRule, {
  valid: [
    {
      name: "the owner's own guard",
      filename: briefing,
      code: "declare const ianaTimezoneBrand: unique symbol; export type IanaTimezone = string & { readonly [ianaTimezoneBrand]: true }; export function isIanaTimezone(value: unknown): value is IanaTimezone { return typeof value === 'string'; }",
    },
    {
      name: "the owner's assertion guard",
      filename: briefing,
      code: "declare const ianaTimezoneBrand: unique symbol; export type IanaTimezone = string & { readonly [ianaTimezoneBrand]: true }; export function assertIanaTimezone(value: string): asserts value is IanaTimezone {}",
    },
    {
      name: "the owner's z.custom schema",
      filename: localTime,
      code: "import { z } from 'zod'; declare const localDateKeyBrand: unique symbol; export type LocalDateKey = string & { readonly [localDateKeyBrand]: true }; export const localDateKeySchema = z.custom<LocalDateKey>((v) => typeof v === 'string');",
    },
    {
      name: "a caller wraps the owner's guard with no predicate",
      filename: "probe.ts",
      code: "import { isIanaTimezone, type IanaTimezone } from '@alfred/contracts'; export function zoneOr(value: unknown, fallback: IanaTimezone): IanaTimezone { return isIanaTimezone(value) ? value : fallback; }",
    },
    {
      name: "a brand in a parameter or return type is not a mint",
      filename: "probe.ts",
      code: "import type { LocalDateKey } from '@alfred/assistant/time'; export function next(day: LocalDateKey): LocalDateKey { return day; }",
    },
    {
      name: "a guard of a type that is not a brand",
      filename: "probe.ts",
      code: "type Row = { id: string }; export function isRow(value: unknown): value is Row { return typeof value === 'object'; }",
    },
    {
      name: "a z.custom of a type that is not a brand",
      filename: "probe.ts",
      code: "import { z } from 'zod'; import type { ToolName } from '@alfred/contracts'; export const toolNameSchema = z.custom<ToolName>((v) => typeof v === 'string');",
    },
    {
      name: "a local type with a brand name shadows the import name",
      filename: "probe.ts",
      code: "type LocalDateKey = `${number}-${number}-${number}`; export function isKey(value: string): value is LocalDateKey { return /^\\d/.test(value); }",
    },
    {
      name: "a registered brand declaration in its owner",
      filename: toolRuntime,
      code: "declare const safeToParkWakeBrand: unique symbol; export type SafeToParkWake = { kind: 'signal' } & { deadlineAt: string } & { readonly [safeToParkWakeBrand]: true };",
    },
    {
      // The rule keeps the consolidation gate's file scope (`isSkippedPath`).
      name: "a test tree is out of scope",
      filename: "packages/http/test/zone.test.ts",
      code: "import type { IanaTimezone } from '@alfred/contracts'; const isZone = (v: unknown): v is IanaTimezone => typeof v === 'string';",
    },
    {
      // The shape of `isPassthroughToolArgs` in packages/assistant/src/tool-runtime/internal/registry.ts.
      name: "a guard that narrows a union whose arms already carry the brand",
      filename: "probe.ts",
      code: "import type { IanaTimezone } from '@alfred/contracts'; interface Ctx { timezone: IanaTimezone } interface Live { run: (ctx: Ctx) => void; passthrough?: false } interface Passthrough { run: (ctx: Ctx) => void; passthrough: true } function isPassthrough(args: Live | Passthrough): args is Passthrough { return args.passthrough === true; }",
    },
    {
      name: "a guard that narrows an already-branded value out of null",
      filename: "probe.ts",
      code: "import type { LocalDateKey } from '@alfred/assistant/time'; export const present = (days: (LocalDateKey | null)[]) => days.filter((d: LocalDateKey | null): d is LocalDateKey => d !== null);",
    },
  ],
  invalid: [
    {
      name: "a guard that narrows to a brand its input does not carry",
      filename: "probe.ts",
      code: "import type { IanaTimezone } from '@alfred/contracts'; import type { LocalDateKey } from '@alfred/assistant/time'; export const isDay = (v: IanaTimezone | string): v is LocalDateKey => v.length === 10;",
      errors: [mint("type guard", "LocalDateKey", localTime)],
    },
    {
      name: "a type guard outside the owner (the lesson's first form)",
      filename: "probe.ts",
      code: "import type { IanaTimezone } from '@alfred/contracts'; export function isZone(value: unknown): value is IanaTimezone { return typeof value === 'string'; }",
      errors: [mint("type guard", "IanaTimezone", briefing)],
    },
    {
      name: "an assertion guard outside the owner",
      filename: "probe.ts",
      code: "import type { LocalDateKey } from '@alfred/assistant/time'; export function assertKey(value: string): asserts value is LocalDateKey {}",
      errors: [mint("type guard", "LocalDateKey", localTime)],
    },
    {
      name: "a z.custom outside the owner (the lesson's second form)",
      filename: "probe.ts",
      code: "import { z } from 'zod'; import type { RedactedToolInput } from '@alfred/ai'; export const redactedSchema = z.custom<RedactedToolInput>();",
      errors: [mint("z.custom", "RedactedToolInput", "packages/ai/src/metering/langfuse.ts")],
    },
    {
      name: "a bare imported custom",
      filename: "probe.ts",
      code: "import { custom } from 'zod'; import type { DeliveryInstant } from '../object-state/delivery-instant.ts'; export const s = custom<DeliveryInstant>((v) => typeof v === 'string');",
      errors: [
        mint(
          "z.custom",
          "DeliveryInstant",
          "packages/assistant/src/connections/object-state/delivery-instant.ts",
        ),
      ],
    },
    {
      name: "an arrow guard in a filter",
      filename: "probe.ts",
      code: "import type { LocalDateKey } from '@alfred/assistant/time'; export const keys = (values: string[]) => values.filter((v): v is LocalDateKey => v.length === 10);",
      errors: [mint("type guard", "LocalDateKey", localTime)],
    },
    {
      name: "a renamed import",
      filename: "probe.ts",
      code: "import type { IanaTimezone as Zone } from '@alfred/contracts'; export const isZone = (v: unknown): v is Zone => typeof v === 'string';",
      errors: [mint("type guard", "IanaTimezone", briefing)],
    },
    {
      name: "a same-file alias of the brand",
      filename: "probe.ts",
      code: "import type { SafeToParkWake } from '../tool-runtime/index.ts'; export type ParkWake = SafeToParkWake; export function isParkWake(v: unknown): v is ParkWake { return v !== null; }",
      errors: [mint("type guard", "SafeToParkWake", toolRuntime)],
    },
    {
      name: "a same-file shape with a brand field",
      filename: "probe.ts",
      code: "import type { IanaTimezone } from '@alfred/contracts'; interface Prefs { zone: IanaTimezone } export function isPrefs(v: unknown): v is Prefs { return typeof v === 'object'; }",
      errors: [mint("type guard", "IanaTimezone", briefing)],
    },
    {
      name: "a brand inside a literal predicate type",
      filename: "probe.ts",
      code: "import type { LocalDateKey } from '@alfred/assistant/time'; export function hasDay(v: unknown): v is { day: LocalDateKey } { return typeof v === 'object'; }",
      errors: [mint("type guard", "LocalDateKey", localTime)],
    },
    {
      name: "a namespace-qualified brand",
      filename: "probe.ts",
      code: "import type * as contracts from '@alfred/contracts'; export const isZone = (v: unknown): v is contracts.IanaTimezone => typeof v === 'string';",
      errors: [mint("type guard", "IanaTimezone", briefing)],
    },
    {
      name: "an import() type",
      filename: "probe.ts",
      code: "export const isZone = (v: unknown): v is import('@alfred/contracts').IanaTimezone => typeof v === 'string';",
      errors: [mint("type guard", "IanaTimezone", briefing)],
    },
    {
      name: "a method guard on an object",
      filename: "probe.ts",
      code: "import type { PublicAppErrorMessage } from '@alfred/contracts'; export const check = { isPublic(v: string): v is PublicAppErrorMessage { return v.length > 0; } };",
      errors: [
        mint("type guard", "PublicAppErrorMessage", "packages/contracts/src/app-errors/index.ts"),
      ],
    },
    {
      name: "an owner that guards a brand of another owner",
      filename: localTime,
      code: "import type { IanaTimezone } from '@alfred/contracts'; declare const localDateKeyBrand: unique symbol; export type LocalDateKey = string & { readonly [localDateKeyBrand]: true }; export const isZone = (v: unknown): v is IanaTimezone => typeof v === 'string';",
      errors: [mint("type guard", "IanaTimezone", briefing)],
    },
    {
      name: "a brand that BRANDS does not list",
      filename: "probe.ts",
      code: "declare const userIdBrand: unique symbol; export type UserId = string & { readonly [userIdBrand]: true };",
      errors: [{ messageId: "unlistedBrand", data: { name: "UserId" } }],
    },
    {
      name: "a listed brand declared in a file that is not its owner",
      filename: "probe.ts",
      code: "declare const zoneBrand: unique symbol; export interface IanaTimezone { readonly [zoneBrand]: true }",
      errors: [{ messageId: "unlistedBrand", data: { name: "IanaTimezone" } }],
    },
    {
      name: "a unique symbol that keys no named type",
      filename: "probe.ts",
      code: "declare const looseBrand: unique symbol; export function f(): string & { readonly [looseBrand]: true } { throw new Error('x'); }",
      errors: [{ messageId: "unusedBrandSymbol", data: { name: "looseBrand" } }],
    },
  ],
});
