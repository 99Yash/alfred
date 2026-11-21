import type { TriageCategory } from "@alfred/contracts";
import type { TriageOutOfScope } from "@alfred/assistant/triage/scope";
import type { EvalCorrespondentCounts } from "../lib/stored-mail";

/**
 * The ADR-0121 eval deck (plan slice 0). Most mails are real production mail from the read-only
 * pull on 2026-11-06; the echo cases come from the read-only pull on 2026-11-16, and two cases
 * are synthetic and say so in their notes. The repo is public, so each body is a short excerpt with the
 * owner's address, client ids, card digits, and account links removed. Outside people get a
 * first name and initial on their real domain. Each listed company and the broker get an invented
 * name, so the deck does not show the owner's holdings; the registry senders stay real. The excerpt
 * keeps the text that decides the label.
 *
 * Category ids are the stored ids of today. Slice 2 renames them, and the compiler finds this
 * file: `action_needed` is Action, `payment` is Receipt, `marketing` is Promo, `newsletter` is
 * News, and `awaiting_reply` / `follow_up` are Reply.
 */

/** The input that prod gave the classifier, copied from the `triage.classification` trace. */
export interface DeckMail {
  from: string;
  subject: string;
  body: string;
  authoredAt: string;
  labelIds: readonly string[];
  /**
   * Where the mail sits when triage does not label it (slice 2a). Set: the deck checks that triage
   * skips the mail, and makes no model call. Unset: the mail is in scope, and `accept` applies.
   */
  outOfScope?: TriageOutOfScope;
  /**
   * Stored headers beyond From, Subject, and Date (for example `To`, `Reply-To`,
   * `Authentication-Results`), as Gmail recorded them. With no `To` here, the mail has no To header.
   */
  headers?: Readonly<Record<string, string>>;
  /** The label that prod gave this mail. For the reader only; no scorer reads it. */
  prodCategory: TriageCategory;
  /** Lower-bound correspondent counts for the sender (ADR-0127). Absent: no history line. */
  history?: EvalCorrespondentCounts;
  thread?: {
    messageCount: number;
    newestDirection: "sent" | "received";
    /**
     * When the user's newest dated send in the thread was (`thread-state.ts`). Null or unset:
     * he has not replied.
     */
    lastUserReplyAt?: string;
    /**
     * The thread state the current mail arrives into, newest first (`thread-state.ts`, cap 6,
     * snippet cap 220). Short redacted excerpts, as the prompt renders them.
     */
    recentMessages?: readonly {
      direction: "sent" | "received";
      authoredAt: string;
      snippet: string;
    }[];
  };
  /**
   * The user's own sent messages in the thread, newest first (`MailFacts.ownReplies`). The
   * prompt does not render them yet (slice 3 decides), but the fixture carries them so the
   * reader sees what prod sees.
   */
  ownReplies?: readonly { at: string; text: string }[];
}

export interface DeckCase {
  label: string;
  /**
   * The labels that score 1, from `docs/theory/triage.md`. The owner checks each one. A mail with
   * `outOfScope` gets no label, so this applies only to the mails in scope.
   */
  accept: readonly [TriageCategory, ...TriageCategory[]];
  /**
   * Set when every mail is the same kind of mail from one sender. The theory then requires
   * one label for the group. A case that only groups related mail leaves it unset.
   */
  oneKind?: true;
  /** Why the theory gives this label. The judge-free scorers print it on a miss. */
  note: string;
  mails: readonly [DeckMail, ...DeckMail[]];
}

/** Every quiet label except `meeting`. Use it when the theory says "quiet" and no more. */
const QUIET = ["fyi", "done", "receipt", "news", "promo"] as const;

const UPDATES = ["UNREAD", "CATEGORY_UPDATES", "INBOX"] as const;

const PROMOTIONS = ["CATEGORY_PROMOTIONS", "UNREAD", "INBOX"] as const;

export const DECK: readonly DeckCase[] = [
  // ── Same sender, same kind of mail: one label ─────────────────────────────
  {
    label: "chess-streak-mail-keeps-one-label",
    oneKind: true,
    accept: ["promo"],
    note: "Chess.com streak nudges sell engagement. Nothing is owed and no person waits. Prod gave the same kind of mail action_needed, newsletter, and fyi.",
    mails: [
      {
        from: '"♟Chess.com" <streaks@chess.com>',
        subject: "😱 Your 5 Day Streak is About to End!",
        body: "Play a quick game or Puzzle before midnight to save it! Keep Your 5 Day Streak Alive! Hey player, your 5 day streak needs rescuing! Keep it going before midnight.",
        authoredAt: "2026-11-05T12:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
      {
        from: '"Chess.com" <streaks@chess.com>',
        subject: "Your Streak is paused at 5 days! ⏸️",
        body: "Play a game or solve a Puzzle before midnight to keep going! Unpause Your Streak. Go for your highest streak! Play a game, do a puzzle, or review a game to keep your streak alive.",
        authoredAt: "2026-11-04T12:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
      {
        from: '"Chess.com" <streaks@chess.com>',
        subject: "player, You’re on a 5 Day Streak! 🔥",
        body: "Keep it going with a quick game or Puzzle before midnight! Keep Your Streak Alive! Play a game, do a puzzle, or review a game to add to your streak. Extend Your Streak.",
        authoredAt: "2026-11-03T12:00:00Z",
        labelIds: UPDATES,
        prodCategory: "news",
      },
      {
        from: '"Chess.com" <streaks@chess.com>',
        subject: "Your Streak is at 1 days, player! 🔥",
        body: "Keep it going with a quick game or Puzzle before midnight! Keep Your Streak Alive! Play a game, do a puzzle, or review a game to add to your streak. Extend Your Streak.",
        authoredAt: "2026-10-26T12:00:00Z",
        labelIds: UPDATES,
        prodCategory: "fyi",
      },
    ],
  },
  {
    label: "chess-promo-mail",
    accept: ["promo", "news"],
    note: "A game-review upsell and a monthly recap from a consumer app. The owner, 2026-11-07: marketing. News also passes, but he never subscribed; he only logged in to chess.com.",
    mails: [
      {
        from: '"Chess.com" <hello@chess.com>',
        subject: "Use it or Lose it! ⌛",
        body: "Use your free Daily Game Review for your game against an opponent! What a Game! See the highlights of your game with your daily Game Review!",
        authoredAt: "2026-10-26T12:05:01Z",
        labelIds: PROMOTIONS,
        outOfScope: "promotions",
        prodCategory: "promo",
      },
      {
        from: '"Chess.com" <hello@chess.com>',
        subject: "player, Here’s Your Month in Chess!",
        body: "See your games, wins, puzzles and more from last month. Your October in Chess: 22 Games Played, 10 Wins, 0 Rated Puzzles Solved. Play Now.",
        authoredAt: "2026-11-05T12:00:00Z",
        labelIds: PROMOTIONS,
        outOfScope: "promotions",
        prodCategory: "news",
      },
    ],
  },

  // ── Money went wrong: loud, never Receipt ─────────────────────────────────
  {
    label: "github-billing-lock",
    accept: ["urgent", "action"],
    note: "GitHub cannot bill the account and service stops. On 2026-11-06 GitHub locked the account and every CI job stopped. Prod said payment: the worst error.",
    mails: [
      {
        from: "GitHub <noreply@github.com>",
        subject: "[GitHub] We had a problem billing your account",
        body: "Greetings, This email is to inform you that we cannot bill your account. There is currently no payment method on file. A payment method must be added to continue service. To update your payment information, please head to https://github.com/settings/billing/payment_information",
        authoredAt: "2026-11-06T09:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "receipt",
      },
    ],
  },
  {
    label: "voyage-payment-failed",
    accept: ["action", "urgent"],
    note: "A payment failed and access is at risk. Action, never Receipt.",
    mails: [
      {
        from: "support@voyageai.com",
        subject: "Your Voyage AI payment failed",
        body: "Hi, We were unable to process your Voyage AI payment of $1.13 for October 2026 for your organization. To ensure uninterrupted access to Voyage AI services, please update your payment method and complete your payment as soon as possible: Update Payment Method. We'll automatically retry your payment on Nov 6, 2026.",
        authoredAt: "2026-11-02T21:45:53Z",
        labelIds: UPDATES,
        prodCategory: "receipt",
      },
    ],
  },
  {
    label: "greptile-out-of-credits",
    accept: ["action", "urgent"],
    note: "Zero credits left, and code reviews pause. A service will stop: Action.",
    mails: [
      {
        from: "Greptile <hello@greptile.com>",
        subject: "Low credit balance for Yashk",
        body: "Hello, Yashk has 0 credits left. When they run out, Greptile will pause code reviews until you add more. Add credits now to keep reviews running. You can also turn on automatic recharge to top up whenever your balance drops below an amount you set.",
        authoredAt: "2026-10-31T06:00:00Z",
        labelIds: UPDATES,
        prodCategory: "receipt",
      },
    ],
  },
  {
    label: "railway-confirm-card-payment",
    accept: ["action", "urgent"],
    note: "The bank holds the monthly payment until the owner confirms it. A payment that needs an action is Action.",
    mails: [
      {
        from: "Railway Corporation <billing+acct_1HNrvlCJoPsRzQsd@stripe.com>",
        subject: "Important: Confirm your $5.81 payment to Railway Corporation",
        body: "Railway Corporation. Confirm your $5.81 payment. Confirm your monthly payment to Railway Corporation using Discover ProtectBuy. Your bank requires this security measure for your card. Confirm payment.",
        authoredAt: "2026-10-23T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "receipt",
      },
    ],
  },
  {
    label: "voyage-review-payment-method-by-date",
    accept: ["action"],
    note: "A billing change with a real deadline: review the default payment method by October 26. Action.",
    mails: [
      {
        from: "Voyage AI <team@voyage.mongodb.com>",
        subject: "Action required: Review your Voyage AI default payment method by October 26",
        body: "Hi Yash, We're updating Voyage AI's billing process to make payments more seamless and automated. Starting with the October 2026 billing cycle, we'll automatically charge your default payment method instead of sending invoices for manual payment. What you need to do by October 26, 2026: Log in to your Voyage AI dashboard and navigate to the Billing section. Review your saved payment methods and confirm your preferred default payment method.",
        authoredAt: "2026-10-19T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "receipt",
      },
    ],
  },

  // ── Money moved and nothing went wrong: Receipt ───────────────────────────
  {
    label: "receipts-and-zero-invoices",
    accept: ["receipt"],
    note: "Paid receipts and a $0.00 invoice. Money moved, nothing went wrong.",
    mails: [
      {
        from: "Railway Corporation <invoice+statements+acct_1HNrvlCJoPsRzQsd@stripe.com>",
        subject: "Your receipt from Railway Corporation #2170-5023",
        body: "Railway Corporation. Receipt from Railway Corporation $5.81. Paid on October 23, 2026. Sep 23–Oct 23, 2026. Disk $0.23. Network $0.53. Total $5.81. Amount paid $5.81.",
        authoredAt: "2026-10-24T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "receipt",
      },
      {
        from: "Voyage AI <invoice+statements+acct_1O4eAaJ1Erqf01gG@stripe.com>",
        subject: "Your receipt from Voyage AI #2191-4886",
        body: "Voyage AI. Receipt from Voyage AI $1.13. Paid on November 2, 2026. VoyageAI API usage credit Qty 1 $1.13. Total $1.13. Amount paid $1.13. Download receipt.",
        authoredAt: "2026-11-03T08:00:00Z",
        labelIds: ["CATEGORY_UPDATES", "INBOX"],
        prodCategory: "receipt",
      },
      {
        from: "Cloudflare <noreply@notify.cloudflare.com>",
        subject: "Your invoice is available",
        body: "Your invoice is ready. Your latest Cloudflare invoice is ready for review. Invoice details: Due on: November 1, 2026. Amount: $0.00.",
        authoredAt: "2026-11-01T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "receipt",
      },
    ],
  },
  {
    label: "pricing-change-notice-is-not-a-receipt",
    accept: ["fyi", "news"],
    note: "A future pricing change. No money moved and nothing is due. Prod said payment.",
    mails: [
      {
        from: "Cloudflare <noreply@notify.cloudflare.com>",
        subject: "[Notice] Cloudflare Observability pricing changes starting December 1, 2026",
        body: "Hello, Starting December 1, 2026, Cloudflare Observability will use volume-based pricing for logs and traces ingested and stored on Cloudflare, as announced earlier this month. Workers Paid: your account will automatically get a Paid Observability subscription. No Workers Paid plan: your account stays on the Free Observability plan and will not be charged for Observability.",
        authoredAt: "2026-10-29T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "receipt",
      },
    ],
  },

  // ── Webinars are never Meeting ────────────────────────────────────────────
  {
    label: "vendor-webinars",
    accept: ["promo", "fyi"],
    note: "Vendor webinar invites and a live stream. Not a meeting that the owner attends. Prod gave all four the meeting label.",
    mails: [
      {
        from: '"Marine @ Arize" <mmeyer@arize.com>',
        subject: "Sep 10: test the full agent before you ship",
        body: "Run realistic cases through the deployed agent and compare the results. Prove it end-to-end: experiment on the full agent before you ship a change.",
        authoredAt: "2026-09-08T16:00:00Z",
        labelIds: ["CATEGORY_PROMOTIONS", "UNREAD", "SPAM"],
        outOfScope: "spam",
        prodCategory: "meeting",
      },
      {
        from: '"Marine @ Arize" <mmeyer@email.arize.com>',
        subject: "Map AI Act requirements to release gates",
        body: "What traces and evals can prove, and what they cannot. Traces and evals as EU AI Act evidence.",
        authoredAt: "2026-10-06T16:00:00Z",
        labelIds: PROMOTIONS,
        outOfScope: "promotions",
        prodCategory: "meeting",
      },
      {
        from: '"Marine @ Arize" <mmeyer@email.arize.com>',
        subject: "Query traces in SQL instead of paging every span",
        body: "The database returns the aggregate. Save your spot. Query Phoenix traces with SQL.",
        authoredAt: "2026-10-20T16:00:00Z",
        labelIds: PROMOTIONS,
        outOfScope: "promotions",
        prodCategory: "meeting",
      },
      {
        from: '"Matt Pocock (AI Hero)" <matt@aihero.dev>',
        subject: "live Friday 9AM PT: Poteto on shipping 1,000s of PRs a month",
        body: "Hey Yash, On Friday I'm interviewing Lauren Tan (poteto) live on YouTube. Lauren created pstack and ships thousands of PRs a month. We'll talk about skills, high-velocity software factories, and current techniques for shipping with agents.",
        authoredAt: "2026-09-30T16:00:00Z",
        labelIds: PROMOTIONS,
        outOfScope: "promotions",
        prodCategory: "meeting",
      },
    ],
  },

  // ── Broadcast event invites are never Meeting, however they arrive ────────
  {
    label: "broadcast-event-invites",
    accept: ["promo", "news", "fyi"],
    note: "The three mails prod gave `meeting` in the 14 days to 2026-11-13, which the owner reported as the class: webinar and live-stream scheduling blasts. An open-audience event is never Meeting — even when it invites him by name and offers an add-to-calendar link. The other attendees decide, not the calendar object. Note the subjects carry no event word; the tells are registration and unsubscribe language in the body.",
    mails: [
      {
        from: '"Vlad Matsiiako" <vlad@infisical.com>',
        subject: "When an agent calls an API, who is it acting as?",
        body: "See how to give every agent its own short-lived identity. Hi Yash, Once an agent can reach your APIs and MCP servers, you also need to know who it's acting as, and be able to prove that after the fact. On November 18 at 1 PM ET, Jake Hulberg (Infisical's dev rel) will show how agent identities relate to the machine identities you already manage, then walk through a pattern where an orchestrator assumes a machine identity and mints a short-lived session token for each agent it starts. You'll also see the telemetry side: which orchestrator started which agent, on whose behalf, and every HTTP request and MCP tool call that agent made. → Save your seat. Unsubscribe. Manage preferences.",
        authoredAt: "2026-11-13T13:58:54Z",
        labelIds: ["CATEGORY_PROMOTIONS", "UNREAD", "IMPORTANT", "INBOX"],
        outOfScope: "promotions",
        prodCategory: "meeting",
      },
      {
        from: '"Matt Pocock (AI Hero)" <matt@aihero.dev>',
        subject: "Live Monday: the creators of Pi on writing code in the AI age",
        body: "Hey Yash, I'm doing another live interview, this time with two legends: Armin Ronacher and Mario Zechner. Mario created Pi, the open-source terminal coding agent. Armin created Flask and founded Earendil, where they now maintain Pi together. They've both written about what happens to code quality when agents write it unchecked. You'll learn how the creators of Pi think code should be written in the AI age. LIVE: Writing code that doesn't suck with the creators of Pi. Monday, November 16, 4:20pm UTC, on YouTube. That's 8:20am PT, 11:20am ET, 4:20pm London, 5:20pm Berlin and 9:50pm India. Set a reminder on YouTube. Or add it to your calendar: Google, Apple and Outlook. See you there, Matt. You're getting this because you're on the AI Hero list, and this is a live stream announcement. Unsubscribe from AI Hero live stream announcements.",
        authoredAt: "2026-11-13T03:12:49Z",
        labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "meeting",
      },
      {
        from: '"Vlad Matsiiako" <vlad@infisical.com>',
        subject: "How to give AI agents access without handing them keys",
        body: "Plus a live Agent Vault demo on Wednesday, Nov 18. Hi Yash, AI agents that automate work or power features need real access to APIs, databases, and MCP servers. Handing them long-lived credentials rarely survives a security review. On Wednesday, November 18 at 1 PM ET, Jake Hulberg from Infisical's developer relations team walks through a practical architecture for securing agents in systems you build and run yourself. The session covers: why agents shouldn't hold secrets at all, and how credential brokering through a proxy lets them call services without ever seeing a key; scoping access by intent, down to specific endpoints and MCP tools, with the agent acting on behalf of the person who invoked it. It closes with a live demo using Infisical's Agent Vault. → Save your seat. Unsubscribe. Manage preferences.",
        authoredAt: "2026-11-09T11:07:26Z",
        labelIds: ["CATEGORY_PROMOTIONS", "UNREAD", "IMPORTANT", "INBOX"],
        outOfScope: "promotions",
        prodCategory: "meeting",
      },
    ],
  },

  // ── Investor mail: quiet under the stock instruction ──────────────────────
  {
    label: "evoting-and-agm-notices",
    accept: [...QUIET],
    note: "E-voting windows, an AGM notice, and a postal ballot. The owner said stock mail is not urgent and its meetings are not his concern. The kfintech sender matches no stored rule.",
    mails: [
      {
        from: "CDSL e-Voting <donotreply.evoting@cdslindia.co.in>",
        subject:
          "e-Voting FOR KESTREL MOTORS RE 1/- will be OPEN FROM 23-09-2026 09:00 TO 22-10-2026 17:00 AND Meeting Date & Time NA",
        body: "Central Depository Services (India) Limited. Dear Shareholder, Greetings from CDSL! Reminder for e-Voting of KESTREL MOTORS RE 1/-. Commencement of e-voting 23-09-2026 09:00. Conclusion of e-voting 22-10-2026 17:00. Meeting Date & Time NA.",
        authoredAt: "2026-09-22T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
      {
        from: "evoting@nsdl.com",
        subject:
          "68th Annual General Meeting ('AGM') of the Members of Deccan Minerals Limited is scheduled to be held through VC/OAVM",
        body: "DECCAN MINERALS LIMITED (A Govt. of India Enterprise). Date: 6th September 2026. Ref: Folio / DP ID & Client ID No.: [redacted]. Dear Member(s), We are pleased to inform you that the 68th Annual General Meeting of the Members of Deccan Minerals Limited is scheduled to be held on Monday, the 28th September 2026 at 11:30 A.M. (IST) through two-way Video Conferencing facility / Other Audio-Visual Means. The Annual Report is also available at www.evoting.nsdl.com.",
        authoredAt: "2026-09-06T17:47:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
      {
        from: "sahyadriauto.cs@kfintech.com",
        subject: "Sahyadri Auto Limited - Notice of Postal Ballot (through remote e-voting)",
        body: "Sahyadri Auto Limited. Date: 06 November 2026. Ref: Folio No. / DP Id & Client Id: [redacted]. Dear Member, We wish to inform you that pursuant to the provisions of Sections 110 and 108 of the Companies Act, 2013 read with Rules 22 and 20 of the Companies (Management and Administration) Rules, 2014, Regulation 44 of the SEBI Listing Regulations, and General Circular No. 03/2025.",
        authoredAt: "2026-11-06T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "action",
      },
    ],
  },
  {
    label: "tds-and-results-notices",
    accept: [...QUIET],
    note: "TDS communications and quarterly results from share registries (cameo, kfintech). No stored rule matches these senders. The owner's instruction in words covers them. The cameo mail has a date to submit tax documents; the owner checks that this optional filing stays quiet.",
    mails: [
      {
        from: "GODAVARI ENERGY AND MOBILITY LIMITED <GODAVARIENERGYANDMOBILITY@cameoindia.com>",
        subject:
          "Godavari Energy and Mobility Limited - Communication on Tax Deduction at Source on Dividend",
        body: "Dear Shareholder(s), November 03, 2026. REF: FOLIO_DP_CL_ID: [redacted]. Sub: Communication on Tax Deduction at Source on Dividend. The Board declared an Interim Dividend of Rs. 4.30 per equity share. Record Date: Friday, November 06, 2026. Dividend payout date (on or before): Tuesday, December 01, 2026. Last date to submit tax related documents: Friday, November 06, 2026.",
        authoredAt: "2026-11-03T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "action",
      },
      {
        from: "konkan.reit@kfintech.com",
        subject: "Konkan Office Parks REIT || TDS declaration for Q2 FY27 distributions",
        body: "KONKAN OFFICE PARKS REIT. October 28, 2026. Ref: Folio/DP Id & Client Id No: [redacted]. Dear Unitholder, The distributions by Konkan REIT to Unitholders are characterized as a combination of dividend, interest, repayment of SPV level debt and other income. Please see below a brief summary of the withholding tax implications of the distributions for the period ending September 30, 2026. Interest: Tax will be deducted under Section 393 of the Income-tax Act, 2025.",
        authoredAt: "2026-10-28T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
      {
        from: "cs.nilgiri@kfintech.com",
        subject:
          "Nilgiri Pharma Science Limited - Unaudited Financial Results of Nilgiri Pharma Science Limited for the quarter ended September 30, 2026",
        body: "NILGIRI PHARMA SCIENCE LIMITED. Date: October 30, 2026. Ref: Folio / DP Id & Client Id: [redacted]. Dear Shareholder(s), Sub: Unaudited Financial Results for the quarter and half year ended September 30, 2026. The Board of Directors, at its meeting held on Thursday, October 29, 2026, approved the Unaudited Financial Results (Consolidated and Standalone) of the Company.",
        authoredAt: "2026-10-30T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
    ],
  },
  {
    label: "bse-balance-statement-keeps-one-label",
    oneKind: true,
    accept: [...QUIET],
    note: "The exchange's routine balance statement. Prod gave it action_needed, payment, and fyi, and the trace does not say why.",
    mails: [
      {
        from: "BSE ALERTS <info@bseindia.in>",
        subject: "Funds / Securities Balance",
        body: "Dear Investor, With reference to BSE notices, Stock Brokers are required to upload segregation and monitoring of collateral at client level on daily basis. Your Stockbroker [redacted] BROKING LTD. has reported the details of Funds balance and Securities balance as on 22/08/2026 to Clearing Corporations, is attached. Please follow the procedure given below for opening the attachment. The password is your PAN in upper case. Please note that negative number in the file represents debit balance/balance payable by you.",
        authoredAt: "2026-09-08T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
      {
        from: "BSE ALERTS <info@bseindia.in>",
        subject: "Funds / Securities Balance",
        body: "Dear Investor, With reference to BSE notices, Stock Brokers are required to upload segregation and monitoring of collateral at client level on daily basis. Your Stockbroker [redacted] BROKING LTD. has reported the details of Funds balance and Securities balance as on 30/09/2026 to Clearing Corporations, is attached. Please follow the procedure given below for opening the attachment. The password is your PAN in upper case. Please note that negative number in the file represents debit balance/balance payable by you.",
        authoredAt: "2026-10-17T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "receipt",
      },
    ],
  },
  {
    label: "nse-balance-statement-keeps-one-label",
    oneKind: true,
    accept: [...QUIET],
    note: "The same routine statement from NSE. Prod gave it action_needed and fyi.",
    mails: [
      {
        from: "nse_alerts <nse_alerts@nse.co.in>",
        subject: "Funds/Securities Balance",
        body: "Dear Investor, With reference to NSE circulars, Trading members are required to upload clients' securities balance on a daily basis. Information pertaining to your fund and securities balance provided by your trading member, along with the details of securities ISIN wise, is attached. Please follow the procedure given below for opening the attachment. The password is your PAN number in upper case.",
        authoredAt: "2026-09-19T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
      {
        from: "nse_alerts <nse_alerts@nse.co.in>",
        subject: "Funds/Securities Balance",
        body: "Dear Investor, With reference to NSE circulars, Trading members are required to upload clients' securities balance on a daily basis. Information pertaining to your fund and securities balance provided by your trading member, along with the details of securities ISIN wise, is attached. Please follow the procedure given below for opening the attachment. The password is your PAN number in upper case.",
        authoredAt: "2026-10-30T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "fyi",
      },
    ],
  },
  {
    label: "smallcase-reminders",
    accept: [...QUIET],
    note: "Smallcase investment and rebalance reminders. The owner said: same for smallcase rebalance updates.",
    mails: [
      {
        from: "smallcase <notifications@smallcase.com>",
        subject: "Investment Reminder",
        body: "Investment Reminder. Your monthly investment for the following smallcase is still pending. You can review and edit the reminder details from the Investments tab. Equity & Gold Asset Allocation. Invest Now.",
        authoredAt: "2026-11-05T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "receipt",
      },
      {
        from: "smallcase <notifications@smallcase.com>",
        subject: "Rebalance updates pending for your smallcase",
        body: "Pending Rebalance. Rebalance Update Available. You have rebalance update pending for your smallcase Growth & Value Multicap Model. Quarterly Update: the manager has updated the list of stocks/ETFs in this portfolio. See Update.",
        authoredAt: "2026-09-15T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
    ],
  },

  // ── The owner's own CI and deploys: quiet ─────────────────────────────────
  {
    label: "own-ci-and-deploy-failures",
    accept: ["fyi"],
    note: "Owner, 2026-11-07: alfred ships many PRs a day and he sees each failure in the PR, so even a failed alfred prod build is not loud. Blair is inactive, and a Polylane autofix PR started that deploy. His activity decides, not the sender. Prod had no thread on any of these mails; the thread and own-reply fixtures below are the owner-mandated stand-ins (2026-11-16) for the activity the gather will carry in slice 6: his pushes and merges on the same projects, which the deck could not express before.",
    mails: [
      {
        from: "Railway <hello@notify.railway.app>",
        subject: "Build failed for alfred",
        body: "Build failed! This is awkward. One of your builds failed to leave the wheelhouse. Details: Project: alfred. Service: server. Environment: production. View build logs.",
        authoredAt: "2026-11-03T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "urgent",
        thread: {
          messageCount: 2,
          newestDirection: "received",
          lastUserReplyAt: "2026-11-03T07:45:00Z",
          recentMessages: [
            {
              direction: "sent",
              authoredAt: "2026-11-03T07:45:00Z",
              snippet:
                "Merged the server fix to alfred main — production build will roll, I watch it in the PR",
            },
            {
              direction: "received",
              authoredAt: "2026-11-03T07:44:00Z",
              snippet: "Build started for alfred (production)",
            },
          ],
        },
        ownReplies: [
          {
            at: "2026-11-03T07:45:00Z",
            text: "Merged the server fix to alfred main — production build will roll, I watch it in the PR",
          },
        ],
      },
      {
        from: "Vercel <notifications@vercel.com>",
        subject: "Production deployment failed for blair",
        body: 'Production deployment failed. Hello, Yash. The production deployment for project blair failed on branch main at commit 0a3b055. Build error: Command "pnpm run build" exited with 1. Commit message: Merge pull request #11 from 99Yash/polylane/autofix/xws2fsihx0r1.',
        authoredAt: "2026-11-06T10:05:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
        thread: {
          messageCount: 2,
          newestDirection: "received",
          lastUserReplyAt: "2026-10-20T09:00:00Z",
          recentMessages: [
            {
              direction: "received",
              authoredAt: "2026-11-06T10:00:00Z",
              snippet:
                "Polylane autofix PR #11 merged — production deploy started for blair (commit 0a3b055)",
            },
            {
              direction: "sent",
              authoredAt: "2026-10-20T09:00:00Z",
              snippet: "Merged the last manual change to blair",
            },
          ],
        },
        ownReplies: [
          { at: "2026-10-20T09:00:00Z", text: "Merged the last manual change to blair" },
        ],
      },
      {
        from: "Linear <notifications@linear.app>",
        subject: "Linear checks failed: feat(briefing): read the ADR-0118 activity record in ...",
        body: "You have 1 unread notification on Linear. Open your Inbox. Unsubscribe from these emails.",
        authoredAt: "2026-11-02T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
        thread: {
          messageCount: 2,
          newestDirection: "received",
          recentMessages: [
            {
              direction: "received",
              authoredAt: "2026-11-02T07:51:00Z",
              snippet:
                "Linear checks started on the PR (feat(briefing) — read the ADR-0118 activity record)",
            },
            {
              direction: "received",
              authoredAt: "2026-11-01T16:00:00Z",
              snippet: "Linear checks passed on an earlier push of the same PR",
            },
          ],
        },
      },
      {
        from: "Yash Gourav Kar <notifications@github.com>",
        subject: "[99Yash/alfred] Run failed: ci - main (9fcac39)",
        body: "[99Yash/alfred] ci workflow run. Repository: 99Yash/alfred. Workflow: ci. Duration: 4 minutes and 50.0 seconds. Jobs: db-tests failed (2 annotations). logging-unit-tests succeeded. contracts-unit-tests succeeded. http-tests succeeded. static succeeded.",
        authoredAt: "2026-09-06T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action",
        thread: {
          messageCount: 2,
          newestDirection: "received",
          lastUserReplyAt: "2026-09-06T07:55:00Z",
          recentMessages: [
            {
              direction: "received",
              authoredAt: "2026-09-06T07:56:00Z",
              snippet: "ci workflow run started on main",
            },
            {
              direction: "sent",
              authoredAt: "2026-09-06T07:55:00Z",
              snippet:
                "Merged to alfred main (9fcac39) — CI runs on the merge, I watch it in the PR",
            },
          ],
        },
        ownReplies: [
          {
            at: "2026-09-06T07:55:00Z",
            text: "Merged to alfred main (9fcac39) — CI runs on the merge, I watch it in the PR",
          },
        ],
      },
      {
        from: "Yash Gourav Kar <notifications@github.com>",
        subject:
          "[99Yash/alfred] PR run failed: ci - fix(library): give the artifact viewer the chat rail's width",
        body: "[99Yash/alfred] ci workflow run. Repository: 99Yash/alfred. Workflow: ci. Duration: 3 minutes and 13.0 seconds. Jobs: unit-tests succeeded. db-tests succeeded. http-tests succeeded. duplicates succeeded. leaf-db-tests failed (3 annotations). assistant-unit-tests succeeded.",
        authoredAt: "2026-09-22T07:25:01Z",
        labelIds: UPDATES,
        prodCategory: "action",
        thread: {
          messageCount: 3,
          newestDirection: "received",
          lastUserReplyAt: "2026-09-22T07:20:00Z",
          recentMessages: [
            {
              direction: "sent",
              authoredAt: "2026-09-22T07:20:00Z",
              snippet:
                "Pushed fix(library): give the artifact viewer the chat rail's width to the PR — CI on every push",
            },
            {
              direction: "received",
              authoredAt: "2026-09-22T07:10:00Z",
              snippet:
                "PR run succeeded: ci — fix(library): give the artifact viewer the chat rail's width",
            },
          ],
        },
        ownReplies: [
          {
            at: "2026-09-22T07:20:00Z",
            text: "Pushed fix(library): give the artifact viewer the chat rail's width to the PR — CI on every push",
          },
        ],
      },
    ],
  },

  // ── Cold and AI-written outreach: quiet unless a real person needs him ────
  {
    label: "cold-and-automated-outreach",
    accept: [...QUIET],
    note: "A founder's welcome blast, AI-written outreach, a job-board drip, and a recruiter nudge. No real person waits on the owner. Prod gave the welcome awaiting_reply. The owner, 2026-11-07: the Alignerr nudges go back months and read as marketing. Prod says knownContact=true for Alignerr only because Alfred made a person entity from its inbound mail; he never replied.",
    mails: [
      {
        from: "Samuel at Agensi <samuel@news.agensi.io>",
        subject: "Welcome to Agensi!",
        body: "Thanks for being an early adopter of Agensi! Hi Yash, I'm Samuel Rose, the founder of Agensi. I would love to hear what you think of the platform! Reply to this email and tell me why you made an account, what you're looking to get out of Agensi, and what we can do better. I read every reply. Prefer to look around first? Browse the marketplace.",
        authoredAt: "2026-11-03T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "reply",
      },
      {
        from: "Anand from AgentCall <hi@agentcall.dev>",
        subject: "thank you for your open-source work",
        body: "Hi Yash, Thank you for everything you've shared in open source. You came up on a list of developers whose public work a lot of people rely on, and I wanted to say thanks. We're a small, early-stage team. We built AgentCall, a skill that lets agents like Claude Code or Codex join a Google Meet, Zoom or Teams call.",
        authoredAt: "2026-11-02T08:00:00Z",
        labelIds: ["UNREAD", "CATEGORY_UPDATES", "SPAM"],
        outOfScope: "spam",
        prodCategory: "promo",
      },
      {
        from: "Clera Talents <talent@getclera.com>",
        subject: "a quick hello from clera!",
        body: "Why you are hearing from us, and what happens next. Welcome to Clera. Let the right opportunities come to you. You may have first heard from someone working with Clera about an opportunity, rather than from Clera directly.",
        authoredAt: "2026-10-04T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "promo",
      },
      {
        from: "Grace T. <g@tunebyalignerr.com>",
        subject: "Re: Software engineering opportunities at Alignerr",
        body: "Hi Yash, Just wanted to drop another quick note in case you're still looking for flexible, project-based work that fits your full-stack background. Our software engineering projects continue to be a strong fit for developers experienced in Next.js and TypeScript. If you'd like to pick up where you left off, you can complete your setup.",
        authoredAt: "2026-09-28T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "action",
      },
    ],
  },
  {
    label: "newsletter-about-a-hack-is-not-a-security-alert",
    accept: ["news", "promo"],
    note: 'A job-board newsletter whose headline is about a hack. Nothing of the owner\'s is exposed. Prod said urgent through the security floor (`+floor`): its regex reads "No private key leaked" as a leak. Slice 3 must narrow that check.',
    mails: [
      {
        from: "JS Pulse <pulse@jsgurujobs.com>",
        subject: "The Binance Hack Started on One Laptop",
        body: "Think twice before you npm install a take-home. Plus 5 remote JS roles with salary and location. JS Pulse #9 from jsgurujobs.com. The Binance Hack Started on One Laptop. Binance links the breach to a compromised DevOps engineer's laptop that gave the attacker a path to a service container and the ability to submit unauthorized withdrawals. No private key leaked. This issue's sponsor slot is open.",
        authoredAt: "2026-11-02T08:00:00Z",
        labelIds: ["UNREAD", "CATEGORY_UPDATES", "SPAM"],
        outOfScope: "spam",
        prodCategory: "urgent",
      },
    ],
  },
  {
    label: "deepinfra-scoped-keys-newsletter-is-quiet",
    accept: ["news"],
    note: "A newsletter-shaped sender — a newsletter@ address, a list-unsubscribe header, and a 'you signed up' footer — is subscribed content: news. A deprecation date on a convenience default (future key creation without scopes gets rejected) stops nothing of the owner's; only evidence of his own use could make it action, and no such use exists on record. Prod gave action at 0.9 from the first pass alone; the gather that the loud-plus-bulk-sender trigger starts is slice 6 and was not built. Three prompt-wording attempts (case line, principle folded into the quiet bullet, burden-of-proof line) moved the label 0.9 to 0.8 but never flipped it, and the principle-form rewrite regressed sign-in-by-another-person and the chess-streak cases in the paired probe, so the prompt change was reverted. The miss waits for slice 6. Owner decision 2026-11-19.",
    mails: [
      {
        from: "DeepInfra <newsletter@deepinfra.com>",
        subject: "Scoped API keys: a change coming on 2 December",
        body: `From 2 December, new API keys need an explicit scope list. Here's what changes.

DeepInfra has rolled out scoped API keys! Below: what scopes do, a change to key creation coming on 2 December, and how to limit the keys you already have.

Scoped API keys are live. Since 3 November, you can specify scopes when you create an API key. Scopes limit the actions that key can successfully perform. Every existing scope is described in our documentation.

Key creation will require a scope list. In two weeks, on 2 December, API key creation requests that don't specify scopes will be rejected. An unrestricted key has every non-sensitive scope, including scopes we add later. If you still need unrestricted behavior, send an explicit scope list of ["unrestricted"]. These calls are already supported today, so you can update your integration now.

You can edit a key's scopes. Keys created before scopes existed are unrestricted. To limit one, open it in API key management in the DeepInfra dashboard, switch it to Scoped, and pick the scopes it needs.

Kind regards, — The DeepInfra team

You are receiving this because you signed up at deepinfra.com.`,
        authoredAt: "2026-11-18T17:00:50Z",
        labelIds: UPDATES,
        prodCategory: "action",
      },
    ],
  },
  {
    label: "a-person-answered-his-question",
    accept: ["done", "fyi"],
    note: "A real person answers the owner's question in his own thread. Nothing is asked of him.",
    mails: [
      {
        from: "Joeri B. <j@agensi.io>",
        subject: "Re: Re: Agensi x Yash",
        body: "Hi Yash, Stripe does not cover India for us, so payouts there run through Zoneless, which pays out in USDC on Solana to your own wallet within 72 hours. There is no direct bank payout for India right now. A free listing needs no payout setup at all. Best, Joeri",
        authoredAt: "2026-11-03T04:08:46Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "done",
        thread: {
          messageCount: 4,
          newestDirection: "sent",
          lastUserReplyAt: "2026-11-02T18:40:00Z",
          recentMessages: [
            {
              direction: "sent",
              authoredAt: "2026-11-02T18:40:00Z",
              snippet:
                "Hi Joeri — quick one before we go further: for a free listing, do I need payout setup first? Does Stripe work for India, or how do payouts run here?",
            },
          ],
        },
        ownReplies: [
          {
            at: "2026-11-02T18:40:00Z",
            text: "Hi Joeri — quick one before we go further: for a free listing, do I need payout setup first? Does Stripe work for India, or how do payouts run here?",
          },
        ],
      },
    ],
  },

  // ── A real matter: loud ───────────────────────────────────────────────────
  {
    label: "railway-secrets-exposed-rotate",
    accept: ["urgent", "action"],
    note: "The owner's production runs on Railway, and Railway says env secrets may be exposed. Rotate them now.",
    mails: [
      {
        from: "Railway Support <support@railway.app>",
        subject: "Urgent: Railway Security Disclosure - Rotate Credentials",
        body: "Earlier this morning, Railway detected anomalous activity involving systems that store customer environment variables. Our investigation to date indicates that an unauthorized third party may have accessed encrypted environment variables and, for some of them, obtained the decrypted contents. Environment variables may contain secrets such as API keys or database credentials. What you should do: Immediately revoke and reissue all environment variables, including any API keys, stored in Railway.",
        authoredAt: "2026-10-21T08:00:00Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "urgent",
      },
    ],
  },
  // ── Gmail filed it as spam ─────────────────────────────────────────────────
  {
    label: "spam-filed-sign-this-invite-sent-bcc-style",
    accept: ["fyi", "promo"],
    note: "Gmail filed it as spam. The user is not in To or Cc, and the mail asks to review and sign a stranger's document through a link. Authentication passes, so the sender's own account sent it; that does not make the ask real. Prod gave action_needed, and the morning brief showed it. After slice 2a, spam is not tagged: this case checks the skip, and the briefing must say the mail is in spam.",
    mails: [
      {
        from: "H. Blake <h.blake@studio-example.com>",
        subject:
          "Invitation: Studio Project Collaboration @ Tue Nov 10, 2026 4pm - 5pm (EDT) (H. Blake)",
        body: "H. Blake from Studio sent you an invitation, please review and sign. Review Document <https://app.powerbi.com/view?r=REDACTED> ________________________________ From: Erin C. <erin@studio-example.com> Sent: Thursday, August 3, 2023 18:57 To: Victoria B. <victoria@studio-example.com>",
        authoredAt: "2026-11-09T22:16:13Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "SPAM"],
        outOfScope: "spam",
        headers: {
          To: "",
          "Authentication-Results":
            "mx.google.com; dkim=permerror (no key for signature) header.i=@studio-example.com; arc=pass; spf=pass (google.com: domain of h.blake@studio-example.com designates 2a01:111:f403:c107::1 as permitted sender) smtp.mailfrom=h.blake@studio-example.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=studio-example.com",
        },
        prodCategory: "action",
      },
    ],
  },
  {
    label: "spam-filed-recruiter-ask-on-the-users-own-application",
    accept: ["action", "reply"],
    note: "Synthetic, from #1098: Gmail's filter is wrong about 1 time in 100. The user applied for the role, the recruiter writes to the user directly with a deadline, and authentication passes. The ask is the user's own obligation, so it stays loud. prodCategory is what the hard spam floor of #1097 gave this shape. After slice 2a, spam is not tagged: this case checks the skip, and the briefing must say the mail is in spam.",
    mails: [
      {
        from: "Priya N. <priya@talent.acme-example.com>",
        subject: "Re: Backend Engineer application: next step",
        body: "Hi Yash, thanks for applying to the Backend Engineer role. The team liked your profile. The next step is a short take-home task; please send it back by Friday 6 pm IST, or tell me if you need more time. Best, Priya",
        authoredAt: "2026-11-06T09:30:00Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "SPAM"],
        outOfScope: "spam",
        headers: {
          "Authentication-Results":
            "mx.google.com; dkim=pass header.i=@talent.acme-example.com; spf=pass (google.com: domain of priya@talent.acme-example.com designates 198.51.100.7 as permitted sender) smtp.mailfrom=priya@talent.acme-example.com; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=acme-example.com",
        },
        prodCategory: "fyi",
        thread: {
          messageCount: 2,
          newestDirection: "received",
          lastUserReplyAt: "2026-11-04T06:00:00Z",
          recentMessages: [
            {
              direction: "sent",
              authoredAt: "2026-11-04T06:00:00Z",
              snippet: "Application for the Backend Engineer role — resume attached, a line on fit",
            },
          ],
        },
        ownReplies: [
          {
            at: "2026-11-04T06:00:00Z",
            text: "Application for the Backend Engineer role — resume attached, a line on fit",
          },
        ],
      },
    ],
  },

  // ── Echoes of the user's own actions (theory: triage.md, echoes) ──────────
  {
    label: "echoes-of-the-users-own-sign-ins",
    accept: ["fyi"],
    note: "The nine sign-in and OTP echoes of the 2026-11-13 cluster (probe P1, 2026-11-14): three Google accounts signed in on the new Galaxy A56 within one minute, then Samsung, Uber, Myntra, Zerodha (login and 2FA OTP), and Zomato through the evening — all records of an act Yash did himself, setting up the phone that day. Prod gave every one urgent (five were loud by the morning of 2026-11-13, the fault the theory's echo section answers). An echo is FYI: it is never Urgent and never Action. The A56 order trail is the journal case for the join, not a deck case.",
    mails: [
      {
        from: "Google <no-reply@accounts.google.com>",
        subject: "Security alert",
        body: "A new sign-in on Galaxy A56 5G. We noticed a new sign-in to your Google Account on a Galaxy A56 5G device. If this was you, you don't need to do anything. If not, we'll help you secure your account.",
        authoredAt: "2026-11-13T05:55:45Z",
        labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "urgent",
      },
      {
        from: "Google <no-reply@accounts.google.com>",
        subject: "Security alert for [redacted]@gmail.com",
        body: "This is a copy of a security alert sent to [redacted]@gmail.com. A new sign-in on Galaxy A56 5G. We noticed a new sign-in to your Google Account on a Galaxy A56 5G device. If this was you, you don't need to do anything. If not, we'll help you secure your account.",
        authoredAt: "2026-11-13T05:55:47Z",
        labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "urgent",
      },
      {
        from: "Google <no-reply@accounts.google.com>",
        subject: "Security alert for [redacted]@oliv.ai",
        body: "This is a copy of a security alert sent to [redacted]@oliv.ai. A new sign-in on Galaxy A56 5G. We noticed a new sign-in to your Google Account on a Galaxy A56 5G device. If this was you, you don't need to do anything. If not, we'll help you secure your account.",
        authoredAt: "2026-11-13T05:55:48Z",
        labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "urgent",
      },
      {
        from: "Samsung account <sa.noreply@samsung-mail.com>",
        subject: "New sign-in to your Samsung account",
        body: "New sign-in to your Samsung account. Your Samsung account was signed in to from a new device. Device Galaxy A56 5G. Date and time 2026.11.13 am 11:31 (India Time). Location India. If it wasn't you who signed in, reset your password now to keep your account secure.",
        authoredAt: "2026-11-13T06:01:21Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "urgent",
      },
      {
        from: "Uber <noreply@uber.com>",
        subject: "New device sign-in",
        body: "Your Uber account has been signed into from a new device. New device log-in. Please review the details below to confirm it was you. Date and time of sign-in: 2026-11-13 06:46:38 UTC. Sign-in country: India. Type of device: Android. If this wasn't you, reset your password below.",
        authoredAt: "2026-11-13T06:46:39Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "urgent",
      },
      {
        from: "Myntra <no-reply@myntra.com>",
        subject: "New Device Login",
        body: "Login detected on new device. Hey Yash Gourav, We noticed a new login for your account. Date & Time: 13 November 2026 19:29:18. Device: SM-A566E. If this was you, please disregard this mail. If this wasn't you, we recommend you to reset your password immediately.",
        authoredAt: "2026-11-13T13:59:20Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "urgent",
      },
      {
        from: "Zerodha <auth@mailer.zerodha.net>",
        subject: "Important: Login from new device and location",
        body: "Hi Yash, Your account [redacted] has logged in from a new device and location. If this is not you, use the forgot password option immediately and reset your login credentials. Location [redacted], India. Device Kite (samsung SM-A566E; Android 17). Time 2026-11-13T19:40:58+05:30.",
        authoredAt: "2026-11-13T14:10:58Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "urgent",
      },
      {
        from: "Zerodha <noreply@alertsmailer.zerodha.net>",
        subject: "[code] is your Kite 2FA OTP",
        body: "Kite — 2FA OTP to login to your account [redacted] is [code]. If you did not initiate this login request, someone may be trying to gain access to your account.",
        authoredAt: "2026-11-13T14:10:58Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "urgent",
      },
      {
        from: "Zomato <noreply@zomato.com>",
        subject: "Login Alert for your Zomato account!",
        body: "Hi Yash Gourav Kar, We noticed a login to your account. Device: Samsung SM-A566E. Time: 13 Nov, 09:37 PM IST. If this was you, you can ignore this message. There's no need to take any action. If this wasn't you, protect your account by clicking here.",
        authoredAt: "2026-11-13T16:07:42Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "urgent",
      },
    ],
  },
  {
    label: "sign-in-by-another-person-is-loud",
    accept: ["urgent", "action"],
    note: "Synthetic, from the theory's echo section: 'The deck also needs a sign-in by another person, with a loud label, so that it guards the worst error too.' No prod mail shows one yet (checked 2026-11-16). The same sign-in shape as the echo case, but the facts point to another person: a device Yash does not use, a place he is not in, at an hour outside his pattern. It is a security notice, not an echo: the loud question applies.",
    mails: [
      {
        from: "Acme Studio <no-reply@notify.acme-example.com>",
        subject: "New sign-in to your Acme account",
        body: "New sign-in to your Acme account. Your account was signed in to from a new device. Device: Windows PC. App: Acme Studio desktop. Location: Sao Paulo, Brazil. Date and time: 2026-11-14 03:42 (India Time). If this wasn't you, reset your password now to keep your account secure.",
        authoredAt: "2026-11-13T22:12:00Z",
        labelIds: ["UNREAD", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "urgent",
      },
    ],
  },
];
