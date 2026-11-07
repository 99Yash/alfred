/**
 * The 21 active standing-instruction rows in production on 2026-11-06, as stored (all v1).
 * Each value is `unknown`: the deck reads it with `readStoredStandingInstruction`, as prod does.
 * The broker's domains carry an invented name (`examplebroker`); no deck mail comes from them.
 * The stock instruction was saved as a list of sender targets, so a share registry such as
 * kfintech or cameo matches no row. Slice 4 replaces these rows with the instruction in words.
 */
export const PROD_INSTRUCTION_ROWS: readonly {
  factId: string;
  validFrom: string;
  value: unknown;
}[] = [
  {
    factId: "fact_mmutnuvp9roh",
    validFrom: "2026-09-11T07:47:12Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "noreply-cashier@mailer.examplebroker.in",
        label: "Broker payments",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_d5gblk2yzw6o",
    validFrom: "2026-09-11T07:47:15Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "no-reply-transaction-with-holding-statement@reportsmailer.examplebroker.net",
        label: "Broker demat statements",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_odf8zwxx8cgl",
    validFrom: "2026-09-11T07:47:18Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "no-reply-account-statement@reportsmailer.examplebroker.net",
        label: "Broker account statements",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_sgvbn83ocfiu",
    validFrom: "2026-09-11T07:47:21Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "no-reply-contract-notes@reportsmailer.examplebroker.net",
        label: "Broker contract notes",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_3rckfp0zoh2t",
    validFrom: "2026-09-11T07:47:23Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "no-reply-margin-statements@reportsmailer.examplebroker.net",
        label: "Broker margin statements",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_ui5pph8osbne",
    validFrom: "2026-09-11T07:47:25Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "enotices@nsdl.com",
        label: "NSDL e-Notices",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_3atyas8uomf8",
    validFrom: "2026-09-11T07:47:28Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "evoting@nsdl.com",
        label: "NSDL e-Voting",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_49qixu2cq542",
    validFrom: "2026-09-11T07:47:31Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "services@cdslindia.co.in",
        label: "CDSL Services",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_mlw5zvfybqcy",
    validFrom: "2026-09-11T07:47:33Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "donotreply.evoting@cdslindia.co.in",
        label: "CDSL e-Voting",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_tu59bf0yd6gr",
    validFrom: "2026-09-11T07:47:36Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "nse-direct@nse.co.in",
        label: "NSE trade notices",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_yo0ke7di4u8f",
    validFrom: "2026-09-11T07:47:39Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "nse_alerts@nse.co.in",
        label: "NSE alerts",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_medf90smv2ik",
    validFrom: "2026-09-11T07:47:41Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "info@bseindia.in",
        label: "BSE ALERTS",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_dsg2y26gbirp",
    validFrom: "2026-09-11T07:47:44Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "alerts@mailer.examplebroker.in",
        label: "Broker alerts",
        accountId: null,
      },
      effects: ["block_todo_suggestion", "exclude_briefing_priority", "block_reply_draft"],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Treat routine stock and investment notices, including meeting-related emails, from this sender as low priority. Do not mark routine messages as urgent, create calendar events, or surface them as reminders or briefing items. If a message is genuinely urgent or requires immediate action, it may be surfaced. The user is only passively invested and the amount is small. The emails may remain in Gmail.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_9n2vhu0tpymp",
    validFrom: "2026-09-26T04:57:56Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "notifications@smallcase.com",
        label: "Smallcase",
        accountId: null,
      },
      effects: [
        "block_todo_suggestion",
        "exclude_briefing_priority",
        "block_reply_draft",
        "deprioritize_triage_category",
      ],
      surface: "open_loop",
      phrasing: "same for smallcase rebalance updates. remove action items from this and polylane",
      directive:
        "Treat routine Smallcase rebalance notices and Polylane messages as FYI, not urgent. Do not create or surface action items, reminders, or briefing items from these senders. A genuinely urgent message may still be surfaced.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_ricktyy6c1gc",
    validFrom: "2026-09-26T04:57:56Z",
    value: {
      action: "suppress",
      target: {
        kind: "sender_email",
        email: "mail@mail.polylane.com",
        label: "Polylane",
        accountId: null,
      },
      effects: [
        "block_todo_suggestion",
        "exclude_briefing_priority",
        "block_reply_draft",
        "deprioritize_triage_category",
      ],
      surface: "open_loop",
      phrasing: "same for smallcase rebalance updates. remove action items from this and polylane",
      directive:
        "Treat routine Smallcase rebalance notices and Polylane messages as FYI, not urgent. Do not create or surface action items, reminders, or briefing items from these senders. A genuinely urgent message may still be surfaced.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_58jt1hscpmke",
    validFrom: "2026-10-16T10:06:48Z",
    value: {
      action: "suppress",
      target: { kind: "sender_domain", domain: "reportsmailer.examplebroker.net", accountId: null },
      effects: [
        "block_todo_suggestion",
        "exclude_briefing_priority",
        "block_reply_draft",
        "deprioritize_triage_category",
      ],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive:
        "Stop surfacing reminders and briefing items from any sender at reportsmailer.examplebroker.net.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_fzfok0s3nsyk",
    validFrom: "2026-10-16T10:06:49Z",
    value: {
      action: "suppress",
      target: { kind: "sender_domain", domain: "cdslindia.co.in", accountId: null },
      effects: [
        "block_todo_suggestion",
        "exclude_briefing_priority",
        "block_reply_draft",
        "deprioritize_triage_category",
      ],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive: "Stop surfacing reminders and briefing items from any sender at cdslindia.co.in.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_k08efdyszo4k",
    validFrom: "2026-10-16T10:06:49Z",
    value: {
      action: "suppress",
      target: { kind: "sender_domain", domain: "nsdl.com", accountId: null },
      effects: [
        "block_todo_suggestion",
        "exclude_briefing_priority",
        "block_reply_draft",
        "deprioritize_triage_category",
      ],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive: "Stop surfacing reminders and briefing items from any sender at nsdl.com.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_0upxuzjugbfr",
    validFrom: "2026-10-16T10:06:49Z",
    value: {
      action: "suppress",
      target: { kind: "sender_domain", domain: "nse.co.in", accountId: null },
      effects: [
        "block_todo_suggestion",
        "exclude_briefing_priority",
        "block_reply_draft",
        "deprioritize_triage_category",
      ],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive: "Stop surfacing reminders and briefing items from any sender at nse.co.in.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_2w7sf0qmjycb",
    validFrom: "2026-10-16T10:06:49Z",
    value: {
      action: "suppress",
      target: { kind: "sender_domain", domain: "bseindia.in", accountId: null },
      effects: [
        "block_todo_suggestion",
        "exclude_briefing_priority",
        "block_reply_draft",
        "deprioritize_triage_category",
      ],
      surface: "open_loop",
      phrasing:
        "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders.",
      directive: "Stop surfacing reminders and briefing items from any sender at bseindia.in.",
      schemaVersion: 1,
    },
  },
  {
    factId: "fact_1zrf1xqaw2vc",
    validFrom: "2026-10-16T10:06:49Z",
    value: {
      action: "suppress",
      target: { kind: "sender_domain", domain: "in.mpms.mufg.com", accountId: null },
      effects: [
        "block_todo_suggestion",
        "exclude_briefing_priority",
        "block_reply_draft",
        "deprioritize_triage_category",
      ],
      surface: "open_loop",
      phrasing: "same for smallcase rebalance updates. remove action items from this and polylane",
      directive: "Stop surfacing reminders and briefing items from any sender at in.mpms.mufg.com.",
      schemaVersion: 1,
    },
  },
];
