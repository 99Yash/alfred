# Gate design evidence, 2026-10-17 to 2026-10-18

This file records the cases behind the rules in [gate-design.md](../reference/gate-design.md). It is a dated snapshot. It does not describe the tree after 2026-10-18.

## The port trigger

Three regex gates needed repeated hole fixes. Each port to a stronger rung ended the series.

- `no-function-wrapper-shim` moved to chain scope in #1366. Then it took hole fixes in #1370, #1374, #1375 (`922c3c3f`, "round 3") and #1377 ("round 4"). The port in #1381 closed the six holes that #1377 left, with scope analysis. #1382 then decided read versus change from the initializer.
- `sha256-over-json-stringify` took hole fixes in #1368, #1371, #1373, #1375 and #1378. #1380 ported it to the `alfred` plugin. #1385 then closed the cross-file case: `@alfred/db/hash` became the one hash owner, and `no-exported-hasher` rejects every other exported hasher.
- `no-constants-re-export`, `no-type-re-export-shim` and `no-type-alias-shim` took hole fixes in #1368, #1371, #1372 and #1373. Each one relates an export to an import anywhere in the file, which is a binding question. #1388 ported all three to the `alfred` plugin.

The compiler rules of the same days did not need a series:

- The `humanizeSlug` guard took two steps. #1376 rejected integration slug types and left plain `string` open. #1379 patched that gap at runtime. #1383 admitted only closed literal unions and deleted the runtime patch. After #1383, no spelling remains for a next round to find.
- The regex row `humanize-integration-slug` matched the argument by name. It needed a wider name list (#1369) and optional-chain steps (#1372), and it still could not see `(v) => humanizeSlug(v)`. It stays only as a backstop for a closed provider union that holds no registry slug.
- The exhaustive status maps of #1364 needed no follow-up.

## Suppression hygiene

- When the unused-directive check arrived, the tree held 53 directives that suppressed nothing. Forty named `anti-slop/require-safety-comment-for-type-assertion` inside test scopes where that rule was `"off"`.
- Two directives hid real defects. One in `packages/assistant/src/execution/service.ts` hid a bare `type AgentTx = any` behind a directive for a rule that the config did not have. The `any` hid a write that did not match `AgentError`.
- `require-safety-comment-for-type-assertion` was removed. It had 281 violations of 281 hits under the test and eval exemption, and 0 in product source.
