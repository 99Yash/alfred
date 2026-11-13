# ADR-0126 — The model uses Google Workspace through the Google Workspace MCP servers; the Google credential stays for ingestion and lends its token

**Status.** Accepted; built. Decided with the owner on 2026-11-13. Amends ADR-0068 (the calendar half), ADR-0074 (Google leaves the passthrough tier), ADR-0088 and ADR-0096 (code-owned policy entries), ADR-0093 (a built-in can borrow a credential), and ADR-0114 (a new auth mode). Builds on ADR-0125 (GitHub went the same way) and on the provider rule of the ADR-0093 amendment of 2026-10-23.

**Decision in one paragraph.** Six Google Workspace MCP servers are built-ins: Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, and Google Slides. They are the model's Google tool surface. Their connection rows hold no grant. Each request borrows the access token of the user's Google credential, and the Google credential code refreshes it. Code-owned policy entries, bound to descriptor hashes, let the read tools run without approval. Every write keeps the `high` floor. The REST model tools that the servers cover are deleted. Four REST model tools stay because no server covers them. Background code (ingestion, triage, briefing, knowledge, reply drafts, Drive context search, backfills) stays on REST with the same credential.

## Facts this decision rests on (measured 2026-11-12 and 2026-11-13)

- The GCP project of the Google OAuth client is in the Workspace Developer Preview. The servers are `https://{gmail,calendar,drive,docs,sheets,slides}mcp.googleapis.com/mcp/v1`.
- A plain bearer token from the `google_oauth` credential (a gmail.com account) calls each server with HTTP 200. The servers are stateless.
- Each server publishes `/.well-known/oauth-protected-resource/mcp/v1` with `authorization_servers: ["https://accounts.google.com/"]`. Google has no dynamic client registration. An unauthenticated `tools/list` returns 200, with no 401 challenge.
- The live catalogs have 52 tools. 23 assert `readOnlyHint: true`.
- The People MCP server has only `search_contacts`, `get_user_profile`, and `search_directory_people`. It is not a built-in.
- Drive `create_file` with `contentMimeType` `application/vnd.google-apps.spreadsheet` or `application/vnd.google-apps.presentation` and no content creates an empty Sheet or Slides deck (probe of 2026-11-13; both files were deleted after the probe).

## The decisions

1. **Six built-ins, one for each product.** `BUILT_IN_MCP_CATALOG` gets the keys `gmail`, `calendar`, `drive`, `docs`, `sheets`, and `slides`. Each key's `slug` is the integration of the same name. A label is the product name, with no "MCP" in it (ADR-0093 amendment of 2026-11-12, item 6). Each slug is a live provider, so the server card shows on the provider page and not in the MCP list. An integration allowlist that names `gmail` admits the Gmail server (ADR-0125, decision 6).

2. **The token is borrowed at call time.** `BuiltInDefinition.auth` is `"oauth"` or `"google_credential"`. A `google_credential` row has no `credential_id` and no `auth_server_identity`. `resolveMcpClientAuth` gives it the `borrowed` auth mode of `McpRawClient`. The session reads `getGoogleMcpAccessToken`, which uses the existing refresh code of `packages/integrations/src/google/credentials.ts`. So one row refreshes, and one row holds the auth state.
   - Before the handshake and before each call, the session reads the token. If the credential is absent, is not `active`, or Google refuses the refresh, the session throws `McpGoogleCredentialRequiredError`. The call never starts. The row goes to `auth_required` with the text "Reconnect Google to continue."
   - A 401 from the server also moves the row to `auth_required`, unless the stored token changed after the rejected request.
   - Each entry has `connectedBy: "google"` (the one-control rule of the ADR-0093 amendment of 2026-11-13). So each repair door (`/built-ins/:provider/connect`, `/connections/:id/authorize`, `/connections/:id/reconsent`) sends the user to the existing Google connect flow, and the card links there too. The per-row MCP disconnect is refused: the Google disconnect ends the rows. The Google connect flow does not change, because ingestion needs its refresh token.
   - `syncGoogleWorkspaceConnections` keeps the six rows in step with the credential. The Google callback and the Google disconnect call it. With a usable credential, it creates each row and opens it through `reconnect`, which is an owner open (`openForOwner`). So each catalog publishes, and a `disconnected` row opens again. With no usable credential, it disconnects each row.
   - The MCP keep-alive and recovery passes read only rows with a `credential_id`, so they skip these rows. The Google credential refreshes on use.

3. **One Google account now.** The servers use the user's oldest Google credential row (`created_at`, then `id`). A second account never moves the MCP surface. If that row is not `active`, the surface asks for a Google reconnect. It does not fall to another account. The row key stays `instanceKey: "default"`. A later change can add one MCP connection for each credential with the credential id as the instance key.

4. **Code-owned policy entries lower the reads.** See the ADR-0096 amendment of 2026-11-13. The 23 read tools have pins in `packages/assistant/src/connections/mcp/built-in-tool-pins.ts`. A read with a matching pin and a published `readOnlyHint` gets the `low` tier and the `read` effect class. A changed descriptor puts the tool back to `high`. `pnpm --filter @alfred/assistant mcp:policy-drift` lists the drift, and `--write` refreshes the pins for a review. A Google `mcp.call` follows the policy rule of its integration, not the `mcp` rule (ADR-0125, decision 2). Thus the Gmail Auto/Gated setting controls a `low` Gmail read. A `high` write always shows an approval card.

5. **One guard stays in code.** Local development shares the real Google account. When `gmailMailboxWritesEnabled()` is false, `mcp.call` refuses a call to a Google Workspace server unless the selected descriptor is a read (`isSelectedMcpToolReadOnly`). The refusal comes before the staging row, so it shows no approval card.

6. **The REST model tools that the servers cover are deleted.**

   | Integration | Deleted                                                                                     | Kept                      | MCP tools that cover the deleted ones                                                         |
   | ----------- | ------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
   | gmail       | `search`, `read_message`, `get_thread`, `modify_thread`, `modify_message`, `create_draft`, `request` | `send_draft`              | `search_threads`, `get_message`, `get_thread`, `label_*`, `unlabel_*`, `trash_*`, `create_draft` |
   | calendar    | `list_events`, `create_event`, `update_event`, `delete_event`, `respond_to_event`, `request` | none                      | `list_events`, `search_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `respond_to_event`, `suggest_time` |
   | drive       | `search_files`, `get_file`, `export_file`, `download_file`, `request`                       | none                      | `search_files`, `get_file_metadata`, `read_file_content`, `download_file_content`               |
   | docs        | `get_document`, `request`                                                                   | none                      | `read_doc`, `update_doc`                                                                      |
   | sheets      | `create_spreadsheet`, `get_values`, `update_values`, `batch_update`, `add_sheet`, `request` | `append_values`           | Drive `create_file`, `get_values`, `update_values`, `update_spreadsheet`, `get_spreadsheet`     |
   | slides      | `create_presentation`, `get_presentation`, `batch_update`, `add_slide`, `request`           | none                      | Drive `create_file`, `read_presentation`, `update_presentation`                                |
   | contacts    | none                                                                                        | `search`, `list`, `get`   | none: the People MCP server has no contact list                                               |

   `gmail.send_draft` stays because no server sends mail. `sheets.append_values` stays because no server appends after the last row. The six Google entries have `passthrough: null`.

7. **Background code stays on REST.** Gmail ingestion (watch, Pub/Sub, history, poll, sweep, media, embed), triage and its label writes, briefing, knowledge, reply drafts, the Drive context search source (ADR-0104), cold start, and the backfills keep `@alfred/integrations/google` on the same credential.

## The trade-off (the losses the owner accepted)

The retirement rule: name the failure that each deleted curated tool stopped.

- **The calendar window in the user's timezone (ADR-0068).** `calendar.list_events` resolved "today" and "this week" on the server in the user's IANA zone. The MCP tool takes the times that the model writes. The model can get the zone math wrong again.
- **The refusal to change Alfred's triage labels.** `gmail.modify_thread` and `gmail.modify_message` refused the numbered triage labels, because the history sync reads only added mail and triage would never see the change. The MCP label tools do not know these labels. A write still needs approval.
- **The fixed calendar event id (#1639).** `calendar.create_event` sent a fixed event id, so a repeated call made no second event. The MCP tool has no such id. The `mcp_invocation` ledger barrier refuses an identical unresolved call, and an ambiguous outcome blocks a retry.
- **Sender and subject from `documents`.** `gmail.search` filled the sender and the subject from the ingested `documents` rows. `search_threads` returns what Gmail returns.
- **One account.** `calendar.list_events` read the events of every connected Google account. The MCP surface reads one account (decision 3).
- **The REST passthrough.** The `*.request` tools read any GET endpoint, for example Gmail settings or Drive revisions. A read that no server has is a gap to report (ADR-0125, alternative b).
- **Text from an uploaded file.** `drive.download_file` decoded an upload as text. `download_file_content` returns base64 into the context. `read_file_content` reads text for the types that it supports.
- **Approval on every write.** Each MCP write is `high`, so it always shows an approval card. Some deleted tools were `medium`, which autonomy could run at once.
- **The Developer Preview.** The servers are pre-GA. Google can change a descriptor, a tool, or the terms. A changed read descriptor sends that read back to approval until the pins change.

## Alternatives

- **(a) Give each Google MCP row its own grant through the MCP OAuth flow.** Rejected by the owner. Google has no dynamic registration, so the row would pin the Google client, and two rows would refresh one Google grant. The Google connect flow must stay for ingestion.
- **(b) Keep the REST tools beside the MCP tools.** Rejected, for the reason of ADR-0125 alternative (a): two paths for one provider.
- **(c) Trust `readOnlyHint` alone, or a name pin plus the hint.** Rejected by the owner. A server sets the hint, and a name pin does not see a changed schema. See the ADR-0096 amendment.
- **(d) One MCP connection for each Google account now.** Deferred. It needs the account choice in each call and a label for each account. The design keeps the instance key free for it.
- **(e) Add the People MCP server.** Not now. It has no contact list, so the `contacts.*` tools stay.

## Residual risk

- **The Developer Preview is pre-GA.** Program term (iv) applies: the app is a pre-GA app outside the Workspace domain, and the owner is the same person on both sides. The domain `alfred.beauty` has auto-renew off and expires on 2027-05-21.
- **Descriptor drift.** A changed read descriptor sends that read back to approval. Nothing runs the drift script on a schedule. It needs a live Google token, so it cannot be a CI gate.
- **No test proves the borrow, the pins, or the guard.** The proof is the compiler, the drift script (23 live reads, no drift on 2026-11-13), and a probe on the local database (`references/scratch/probe-google-mcp-stack.ts`): six rows `ready`, `search_threads` and `get_thread` resolve to `low` and `read`, `create_draft` and `trash_thread` resolve to `high` and `unknown`, and a `search_threads` call through the manager completes.
- **The MCP row status is a copy.** A row in `auth_required` stays there until a start, a sync, or a Google reconnect runs. The next call starts again and heals it when the credential works.
- **A token read for each request.** The session reads and opens the credential row for each MCP request. It does not cache the token.
- **Stored transcripts and workflows can name a deleted tool.** They get the treatment of ADR-0125: a retired name is dropped from the active tools, and a call gets an `unknown_tool` result.

## Cross-ref

Amends ADR-0068, ADR-0074, ADR-0088, ADR-0093, ADR-0096, and ADR-0114. Builds on ADR-0125 and ADR-0094. Keeps ADR-0044 (the Google connect flow) and ADR-0104 (the Drive context search source) as they are. Theory: [docs/theory/README.md](../theory/README.md).
