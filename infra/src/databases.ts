// The two dashboard-managed databases and their volumes, as lookups.
//
// Their physical names ("Postgres", "Redis-E37o") capitalize, and the
// provider's name resolution lowercases every declared name, so managing them
// would mean an in-place rename at adopt time. A lookup references them and
// never writes to them: a plan proves they exist (a miss fails with
// `LookupNotFoundError`), and `alchemy destroy` cannot touch them. A later
// slice can move them under management if the owner asks for it.
import * as Railway from "@alchemy.run/railway";
import { PROJECT_ID, PRODUCTION_ENVIRONMENT_ID } from "./project.ts";

export const Db = Railway.Postgres.lookup({
  projectId: PROJECT_ID,
  environmentId: PRODUCTION_ENVIRONMENT_ID,
  serviceId: "05cab70e-e253-4353-a5dc-39376c5ad4d6",
});

export const Cache = Railway.Redis.lookup({
  projectId: PROJECT_ID,
  environmentId: PRODUCTION_ENVIRONMENT_ID,
  serviceId: "12810bc1-eedd-445a-afa2-f6689e0bb5be",
});

export const DbVolume = Railway.Volume.lookup({
  projectId: PROJECT_ID,
  environmentId: PRODUCTION_ENVIRONMENT_ID,
  volumeId: "a21517da-288b-455c-ab06-9cf478f23ecd",
});

export const CacheVolume = Railway.Volume.lookup({
  projectId: PROJECT_ID,
  environmentId: PRODUCTION_ENVIRONMENT_ID,
  volumeId: "accc04aa-f828-411c-8f40-d96850347e68",
});
