// The real Railway project `alfred` — see infra/src/target.ts for the one
// declaration of the production target that this program and the deploy
// workflow's recovery report both read.
import * as Railway from "@alchemy.run/railway";
import { PROJECT_ID } from "./target.ts";

export { PROJECT_ID, PRODUCTION_ENVIRONMENT_ID } from "./target.ts";

export const Alfred = Railway.Project.lookup({ projectId: PROJECT_ID });
