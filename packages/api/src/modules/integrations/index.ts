import { Elysia } from "elysia";
import { googleIntegrationRoutes } from "./google-routes";

export {
  startIngestionWorker,
  stopIngestionWorker,
  closeIngestionQueue,
  getIngestionQueue,
} from "./queue";
export type { IngestionJobData } from "./queue";

export const integrations = new Elysia({ name: "integrations" }).use(googleIntegrationRoutes);
