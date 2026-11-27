/**
 * The production deploy target — the one declaration both entry points read
 * (ADR-0128): the infra program (project.ts, services.ts) and the deploy
 * workflow's recovery report (scripts/railway-observed-deployments.mjs, run
 * by Node 26, which strips the types). A target change edits this file
 * alone; a copy in the report would keep querying a previous environment.
 */

// The real Railway project `alfred` (created in the dashboard on 2026-04-27).
// A lookup references it read-only: this program never creates, adopts or
// deletes the project itself, so `alchemy destroy` cannot remove it.
export const PROJECT_ID = "0ec1ea83-240d-4306-bf7c-7de61d115b82";

/** The production environment created with the project. */
export const PRODUCTION_ENVIRONMENT_ID = "9fbd12bc-6b88-430f-ac88-3ce71b60714b";

/** The app services the program manages, by Railway service name. */
export const PRODUCTION_SERVICES = ["server", "web"] as const;
