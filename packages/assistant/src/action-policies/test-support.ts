/**
 * Test-only cache controls, kept off the production barrel.
 * `_primePolicyCacheForTests` lets a DB-free test reach the gate's approval floor.
 */

export { clearPolicyCacheForTests, _primePolicyCacheForTests } from "./resolve";
