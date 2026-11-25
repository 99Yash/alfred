/**
 * The boot-time route inventory (#1877). Every mounted route must carry the `auth` guard or be
 * on `PUBLIC_ROUTES`. It scans the routes that Elysia really mounted, so a new module that
 * forgets `.guard({ auth: true })` stops the boot, with no list to remember.
 */
import { getPath, isRecord } from "@alfred/contracts";
import type { AnyElysia } from "elysia";
import { requireAuthSession, resolveAuthUser } from "./middleware/auth";

type RouteKey = `${"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL"} /${string}`;

interface PublicRoute {
  readonly route: RouteKey;
  /** What proves the caller, since no session does. */
  readonly reason: string;
}

/** The only routes that may run with no session. Add a row only with the check that replaces it. */
const PUBLIC_ROUTES = [
  {
    route: "GET /api/integrations/google/callback",
    reason: "OAuth redirect; the signed one-time `state` names the user",
  },
  {
    route: "GET /api/integrations/github/callback",
    reason: "OAuth redirect; the signed one-time `state` names the user",
  },
  {
    route: "GET /api/integrations/vercel/callback",
    reason: "OAuth redirect; the signed one-time `state` names the user",
  },
  {
    route: "GET /api/integrations/mcp/callback",
    reason: "MCP OAuth redirect; the signed one-time `state` names the user",
  },
  {
    route: "GET /api/integrations/mcp/client-metadata",
    reason: "public OAuth client metadata document that authorization servers fetch",
  },
  { route: "POST /webhooks/gmail", reason: "Pub/Sub push; the OIDC token is verified" },
  {
    route: "POST /webhooks/inbound/:source",
    reason: "each source descriptor verifies its own signature",
  },
  { route: "POST /webhooks/github", reason: "the GitHub HMAC signature is verified" },
  { route: "POST /webhooks/resend", reason: "the Svix signature is verified" },
  {
    route: "GET /api/shared/:urlSlug",
    reason: "public share read (ADR-0102); the slug is the capability; rate limited",
  },
  { route: "GET /health", reason: "platform health check; no user data" },
  { route: "GET /ready", reason: "platform readiness check; no user data" },
  { route: "GET /api/auth/get-session", reason: "returns null with no session" },
  { route: "POST /api/auth/get-session", reason: "returns null with no session" },
  { route: "ALL /*", reason: "the Better Auth mount checks its own session" },
] as const satisfies readonly PublicRoute[];

/** A lifecycle hook slot holds a function, a `{ fn }` record, or an array of either. */
function hookFunctions(slot: unknown): readonly unknown[] {
  const entries: readonly unknown[] = Array.isArray(slot) ? slot : [slot];

  return entries.map((entry) => (isRecord(entry) && "fn" in entry ? entry.fn : entry));
}

/** Elysia types a route's `hooks` as `any`, so read each slot as `unknown`. */
function isAuthGuarded(hooks: unknown): boolean {
  return (
    hookFunctions(getPath(hooks, "transform")).includes(requireAuthSession) &&
    hookFunctions(getPath(hooks, "beforeHandle")).includes(resolveAuthUser)
  );
}

/**
 * Throws when a route is neither guarded nor public, when a public row also has the guard, or
 * when a public row names no mounted route. Call it once at boot, before the server listens.
 */
export function assertRouteAuthInventory(app: AnyElysia): void {
  const publicRoutes = new Set<string>(PUBLIC_ROUTES.map((row) => row.route));
  const mounted = new Set<string>();
  const problems: string[] = [];

  for (const route of app.routes) {
    const key = `${route.method} ${route.path}`;
    mounted.add(key);
    const hooks: unknown = route.hooks;
    const guarded = isAuthGuarded(hooks);

    if (!guarded && !publicRoutes.has(key)) {
      problems.push(`${key}: no \`auth\` guard and not on PUBLIC_ROUTES`);
    } else if (guarded && publicRoutes.has(key)) {
      problems.push(`${key}: has the \`auth\` guard, so remove its PUBLIC_ROUTES row`);
    }
  }

  for (const key of publicRoutes) {
    if (!mounted.has(key)) problems.push(`${key}: on PUBLIC_ROUTES, but no such route is mounted`);
  }

  if (problems.length > 0) {
    throw new Error(`Route auth inventory failed (#1877):\n  ${problems.join("\n  ")}`);
  }
}
