/**
 * Cache controls for tests only, kept off the production barrel
 * (`@alfred/assistant/action-policies`) so its interface is the nine names production
 * actually calls. Reaching either helper means naming a subpath called `test-support`,
 * which no production file has a reason to write.
 *
 * `_primePolicyCacheForTests` is what lets a DB-free test exercise the dispatch gate's
 * approval floor: the gate calls `resolveApprovalNotifyDelayMs` the moment a call gates,
 * and that is the one policy read the gate cannot short-circuit.
 */

export { clearPolicyCacheForTests, _primePolicyCacheForTests } from "./resolve";
