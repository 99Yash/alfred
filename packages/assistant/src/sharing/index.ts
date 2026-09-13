// Public seam for thread sharing (ADR-0102). Publishing a chat thread to a
// world-readable URL is a product decision — what a snapshot may contain, when
// a click reuses an existing link, what an unauthenticated visitor reads back —
// so all four verbs live under this module and `packages/http/src/sharing.ts`
// holds transport only.
export {
  listThreadShares,
  readSharedThreadPage,
  revokeSharedThread,
  shareThread,
} from "./shared-threads";
