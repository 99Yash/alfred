// The real Railway project `alfred` (created in the dashboard on 2026-04-27).
// A lookup references it read-only: this program never creates, adopts or
// deletes the project itself, so `alchemy destroy` cannot remove it.
import * as Railway from "@alchemy.run/railway";

export const PROJECT_ID = "0ec1ea83-240d-4306-bf7c-7de61d115b82";

export const Alfred = Railway.Project.lookup({ projectId: PROJECT_ID });

/** The production environment created with the project. */
export const PRODUCTION_ENVIRONMENT_ID = "9fbd12bc-6b88-430f-ac88-3ce71b60714b";
