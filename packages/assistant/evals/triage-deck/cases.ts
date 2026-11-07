import type { TriageCategory } from "@alfred/contracts";
import type { TriageSenderKindSignal } from "@alfred/assistant/triage/sender-kind";

/**
 * The ADR-0121 eval deck (plan slice 0). Each mail is a real production mail from the
 * read-only pull on 2026-11-06. The repo is public, so each body is a short excerpt with the
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
  /** The label that prod gave this mail. For the reader only; no scorer reads it. */
  prodCategory: TriageCategory;
  /** Alfred's own past labels for the sender. Slice 1 deletes this input. */
  senderPrior?: { key: string; counts: Partial<Record<TriageCategory, number>> };
  senderKind?: Pick<TriageSenderKindSignal, "kind" | "confidence" | "evidenceCodes">;
  knownContact?: boolean;
  senderRelationship?: string;
  thread?: { messageCount: number; newestDirection: "sent" | "received" };
}

export interface DeckCase {
  label: string;
  /**
   * The labels that score 1, from `docs/theory/triage.md`. The owner checks each one.
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
const QUIET = ["fyi", "done", "payment", "newsletter", "marketing"] as const;

const CHESS_STREAK_KIND = {
  kind: "group",
  confidence: 0.99,
  evidenceCodes: ["gmail:list_id", "gmail:list_unsubscribe"],
} as const satisfies DeckMail["senderKind"];

const UPDATES = ["UNREAD", "CATEGORY_UPDATES", "INBOX"] as const;

const PROMOTIONS = ["CATEGORY_PROMOTIONS", "UNREAD", "INBOX"] as const;

export const DECK: readonly DeckCase[] = [
  // ── Same sender, same kind of mail: one label ─────────────────────────────
  {
    label: "chess-streak-mail-keeps-one-label",
    oneKind: true,
    accept: ["marketing"],
    note: "Chess.com streak nudges sell engagement. Nothing is owed and no person waits. Prod gave the same kind of mail action_needed, newsletter, and fyi.",
    mails: [
      {
        from: '"♟Chess.com" <streaks@chess.com>',
        subject: "😱 Your 5 Day Streak is About to End!",
        body: "Play a quick game or Puzzle before midnight to save it! Keep Your 5 Day Streak Alive! Hey player, your 5 day streak needs rescuing! Keep it going before midnight.",
        authoredAt: "2026-11-05T12:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
        senderPrior: { key: "streaks@chess.com", counts: { newsletter: 1, action_needed: 1 } },
        senderKind: CHESS_STREAK_KIND,
      },
      {
        from: '"Chess.com" <streaks@chess.com>',
        subject: "Your Streak is paused at 5 days! ⏸️",
        body: "Play a game or solve a Puzzle before midnight to keep going! Unpause Your Streak. Go for your highest streak! Play a game, do a puzzle, or review a game to keep your streak alive.",
        authoredAt: "2026-11-04T12:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
        senderPrior: { key: "streaks@chess.com", counts: { newsletter: 1 } },
        senderKind: CHESS_STREAK_KIND,
      },
      {
        from: '"Chess.com" <streaks@chess.com>',
        subject: "player, You’re on a 5 Day Streak! 🔥",
        body: "Keep it going with a quick game or Puzzle before midnight! Keep Your Streak Alive! Play a game, do a puzzle, or review a game to add to your streak. Extend Your Streak.",
        authoredAt: "2026-11-03T12:00:00Z",
        labelIds: UPDATES,
        prodCategory: "newsletter",
        senderPrior: { key: "streaks@chess.com", counts: {} },
        senderKind: CHESS_STREAK_KIND,
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
    accept: ["marketing", "newsletter"],
    note: "A game-review upsell and a monthly recap from a consumer app. The owner, 2026-11-07: marketing. News also passes, but he never subscribed; he only logged in to chess.com.",
    mails: [
      {
        from: '"Chess.com" <hello@chess.com>',
        subject: "Use it or Lose it! ⌛",
        body: "Use your free Daily Game Review for your game against an opponent! What a Game! See the highlights of your game with your daily Game Review!",
        authoredAt: "2026-10-26T12:05:01Z",
        labelIds: PROMOTIONS,
        prodCategory: "marketing",
      },
      {
        from: '"Chess.com" <hello@chess.com>',
        subject: "player, Here’s Your Month in Chess!",
        body: "See your games, wins, puzzles and more from last month. Your October in Chess: 22 Games Played, 10 Wins, 0 Rated Puzzles Solved. Play Now.",
        authoredAt: "2026-11-05T12:00:00Z",
        labelIds: PROMOTIONS,
        prodCategory: "newsletter",
        senderPrior: { key: "hello@chess.com", counts: { marketing: 2 } },
        senderKind: CHESS_STREAK_KIND,
      },
    ],
  },

  // ── Money went wrong: loud, never Receipt ─────────────────────────────────
  {
    label: "github-billing-lock",
    accept: ["urgent", "action_needed"],
    note: "GitHub cannot bill the account and service stops. On 2026-11-06 GitHub locked the account and every CI job stopped. Prod said payment: the worst error.",
    mails: [
      {
        from: "GitHub <noreply@github.com>",
        subject: "[GitHub] We had a problem billing your account",
        body: "Greetings, This email is to inform you that we cannot bill your account. There is currently no payment method on file. A payment method must be added to continue service. To update your payment information, please head to https://github.com/settings/billing/payment_information",
        authoredAt: "2026-11-06T09:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "payment",
        senderPrior: { key: "noreply@github.com", counts: { fyi: 14, action_needed: 16 } },
        senderKind: { kind: "group", confidence: 0.99, evidenceCodes: ["gmail:list_unsubscribe"] },
      },
    ],
  },
  {
    label: "voyage-payment-failed",
    accept: ["action_needed", "urgent"],
    note: "A payment failed and access is at risk. Action, never Receipt.",
    mails: [
      {
        from: "support@voyageai.com",
        subject: "Your Voyage AI payment failed",
        body: "Hi, We were unable to process your Voyage AI payment of $1.13 for October 2026 for your organization. To ensure uninterrupted access to Voyage AI services, please update your payment method and complete your payment as soon as possible: Update Payment Method. We'll automatically retry your payment on Nov 6, 2026.",
        authoredAt: "2026-11-02T21:45:53Z",
        labelIds: UPDATES,
        prodCategory: "payment",
      },
    ],
  },
  {
    label: "greptile-out-of-credits",
    accept: ["action_needed", "urgent"],
    note: "Zero credits left, and code reviews pause. A service will stop: Action.",
    mails: [
      {
        from: "Greptile <hello@greptile.com>",
        subject: "Low credit balance for Yashk",
        body: "Hello, Yashk has 0 credits left. When they run out, Greptile will pause code reviews until you add more. Add credits now to keep reviews running. You can also turn on automatic recharge to top up whenever your balance drops below an amount you set.",
        authoredAt: "2026-10-31T06:00:00Z",
        labelIds: UPDATES,
        prodCategory: "payment",
        senderPrior: { key: "hello@greptile.com", counts: {} },
        senderKind: {
          kind: "group",
          confidence: 0.99,
          evidenceCodes: ["gmail:list_id", "gmail:list_unsubscribe", "gmail:precedence:bulk"],
        },
      },
    ],
  },
  {
    label: "railway-confirm-card-payment",
    accept: ["action_needed", "urgent"],
    note: "The bank holds the monthly payment until the owner confirms it. A payment that needs an action is Action.",
    mails: [
      {
        from: "Railway Corporation <billing+acct_1HNrvlCJoPsRzQsd@stripe.com>",
        subject: "Important: Confirm your $5.81 payment to Railway Corporation",
        body: "Railway Corporation. Confirm your $5.81 payment. Confirm your monthly payment to Railway Corporation using Discover ProtectBuy. Your bank requires this security measure for your card. Confirm payment.",
        authoredAt: "2026-10-23T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "payment",
        senderPrior: { key: "service:stripe-billing", counts: { payment: 3 } },
      },
    ],
  },
  {
    label: "voyage-review-payment-method-by-date",
    accept: ["action_needed"],
    note: "A billing change with a real deadline: review the default payment method by October 26. Action.",
    mails: [
      {
        from: "Voyage AI <team@voyage.mongodb.com>",
        subject: "Action required: Review your Voyage AI default payment method by October 26",
        body: "Hi Yash, We're updating Voyage AI's billing process to make payments more seamless and automated. Starting with the October 2026 billing cycle, we'll automatically charge your default payment method instead of sending invoices for manual payment. What you need to do by October 26, 2026: Log in to your Voyage AI dashboard and navigate to the Billing section. Review your saved payment methods and confirm your preferred default payment method.",
        authoredAt: "2026-10-19T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "payment",
      },
    ],
  },

  // ── Money moved and nothing went wrong: Receipt ───────────────────────────
  {
    label: "receipts-and-zero-invoices",
    accept: ["payment"],
    note: "Paid receipts and a $0.00 invoice. Money moved, nothing went wrong.",
    mails: [
      {
        from: "Railway Corporation <invoice+statements+acct_1HNrvlCJoPsRzQsd@stripe.com>",
        subject: "Your receipt from Railway Corporation #2170-5023",
        body: "Railway Corporation. Receipt from Railway Corporation $5.81. Paid on October 23, 2026. Sep 23–Oct 23, 2026. Disk $0.23. Network $0.53. Total $5.81. Amount paid $5.81.",
        authoredAt: "2026-10-24T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "payment",
        senderPrior: { key: "service:stripe-billing", counts: { payment: 4 } },
      },
      {
        from: "Voyage AI <invoice+statements+acct_1O4eAaJ1Erqf01gG@stripe.com>",
        subject: "Your receipt from Voyage AI #2191-4886",
        body: "Voyage AI. Receipt from Voyage AI $1.13. Paid on November 2, 2026. VoyageAI API usage credit Qty 1 $1.13. Total $1.13. Amount paid $1.13. Download receipt.",
        authoredAt: "2026-11-03T08:00:00Z",
        labelIds: ["CATEGORY_UPDATES", "INBOX"],
        prodCategory: "payment",
        senderPrior: { key: "service:stripe-billing", counts: { payment: 5 } },
      },
      {
        from: "Cloudflare <noreply@notify.cloudflare.com>",
        subject: "Your invoice is available",
        body: "Your invoice is ready. Your latest Cloudflare invoice is ready for review. Invoice details: Due on: November 1, 2026. Amount: $0.00.",
        authoredAt: "2026-11-01T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "payment",
        senderPrior: { key: "noreply@notify.cloudflare.com", counts: { fyi: 1, payment: 5 } },
        senderKind: {
          kind: "service",
          confidence: 0.92,
          evidenceCodes: ["email:local:service_strong"],
        },
      },
    ],
  },
  {
    label: "pricing-change-notice-is-not-a-receipt",
    accept: ["fyi", "newsletter"],
    note: "A future pricing change. No money moved and nothing is due. Prod said payment.",
    mails: [
      {
        from: "Cloudflare <noreply@notify.cloudflare.com>",
        subject: "[Notice] Cloudflare Observability pricing changes starting December 1, 2026",
        body: "Hello, Starting December 1, 2026, Cloudflare Observability will use volume-based pricing for logs and traces ingested and stored on Cloudflare, as announced earlier this month. Workers Paid: your account will automatically get a Paid Observability subscription. No Workers Paid plan: your account stays on the Free Observability plan and will not be charged for Observability.",
        authoredAt: "2026-10-29T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "payment",
        senderPrior: { key: "noreply@notify.cloudflare.com", counts: { fyi: 1, payment: 4 } },
      },
    ],
  },

  // ── Webinars are never Meeting ────────────────────────────────────────────
  {
    label: "vendor-webinars",
    accept: ["marketing", "fyi"],
    note: "Vendor webinar invites and a live stream. Not a meeting that the owner attends. Prod gave all four the meeting label.",
    mails: [
      {
        from: '"Marine @ Arize" <mmeyer@arize.com>',
        subject: "Sep 10: test the full agent before you ship",
        body: "Run realistic cases through the deployed agent and compare the results. Prove it end-to-end: experiment on the full agent before you ship a change.",
        authoredAt: "2026-09-08T16:00:00Z",
        labelIds: ["CATEGORY_PROMOTIONS", "UNREAD", "SPAM"],
        prodCategory: "meeting",
        senderRelationship: "no prior contact on record",
      },
      {
        from: '"Marine @ Arize" <mmeyer@email.arize.com>',
        subject: "Map AI Act requirements to release gates",
        body: "What traces and evals can prove, and what they cannot. Traces and evals as EU AI Act evidence.",
        authoredAt: "2026-10-06T16:00:00Z",
        labelIds: PROMOTIONS,
        prodCategory: "meeting",
        senderRelationship: "no prior contact on record",
      },
      {
        from: '"Marine @ Arize" <mmeyer@email.arize.com>',
        subject: "Query traces in SQL instead of paging every span",
        body: "The database returns the aggregate. Save your spot. Query Phoenix traces with SQL.",
        authoredAt: "2026-10-20T16:00:00Z",
        labelIds: PROMOTIONS,
        prodCategory: "meeting",
        senderRelationship: "no prior contact on record",
      },
      {
        from: '"Matt Pocock (AI Hero)" <matt@aihero.dev>',
        subject: "live Friday 9AM PT: Poteto on shipping 1,000s of PRs a month",
        body: "Hey Yash, On Friday I'm interviewing Lauren Tan (poteto) live on YouTube. Lauren created pstack and ships thousands of PRs a month. We'll talk about skills, high-velocity software factories, and current techniques for shipping with agents.",
        authoredAt: "2026-09-30T16:00:00Z",
        labelIds: PROMOTIONS,
        prodCategory: "meeting",
        senderRelationship: "no prior contact on record",
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
        prodCategory: "action_needed",
        senderPrior: { key: "donotreply.evoting@cdslindia.co.in", counts: { action_needed: 3 } },
      },
      {
        from: "evoting@nsdl.com",
        subject:
          "68th Annual General Meeting ('AGM') of the Members of Deccan Minerals Limited is scheduled to be held through VC/OAVM",
        body: "DECCAN MINERALS LIMITED (A Govt. of India Enterprise). Date: 6th September 2026. Ref: Folio / DP ID & Client ID No.: [redacted]. Dear Member(s), We are pleased to inform you that the 68th Annual General Meeting of the Members of Deccan Minerals Limited is scheduled to be held on Monday, the 28th September 2026 at 11:30 A.M. (IST) through two-way Video Conferencing facility / Other Audio-Visual Means. The Annual Report is also available at www.evoting.nsdl.com.",
        authoredAt: "2026-09-06T17:47:00Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
      },
      {
        from: "sahyadriauto.cs@kfintech.com",
        subject: "Sahyadri Auto Limited - Notice of Postal Ballot (through remote e-voting)",
        body: "Sahyadri Auto Limited. Date: 06 November 2026. Ref: Folio No. / DP Id & Client Id: [redacted]. Dear Member, We wish to inform you that pursuant to the provisions of Sections 110 and 108 of the Companies Act, 2013 read with Rules 22 and 20 of the Companies (Management and Administration) Rules, 2014, Regulation 44 of the SEBI Listing Regulations, and General Circular No. 03/2025.",
        authoredAt: "2026-11-06T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
        prodCategory: "action_needed",
        senderRelationship: "no prior contact on record",
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
        prodCategory: "action_needed",
      },
      {
        from: "konkan.reit@kfintech.com",
        subject: "Konkan Office Parks REIT || TDS declaration for Q2 FY27 distributions",
        body: "KONKAN OFFICE PARKS REIT. October 28, 2026. Ref: Folio/DP Id & Client Id No: [redacted]. Dear Unitholder, The distributions by Konkan REIT to Unitholders are characterized as a combination of dividend, interest, repayment of SPV level debt and other income. Please see below a brief summary of the withholding tax implications of the distributions for the period ending September 30, 2026. Interest: Tax will be deducted under Section 393 of the Income-tax Act, 2025.",
        authoredAt: "2026-10-28T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
        senderRelationship: "no prior contact on record",
      },
      {
        from: "cs.nilgiri@kfintech.com",
        subject:
          "Nilgiri Pharma Science Limited - Unaudited Financial Results of Nilgiri Pharma Science Limited for the quarter ended September 30, 2026",
        body: "NILGIRI PHARMA SCIENCE LIMITED. Date: October 30, 2026. Ref: Folio / DP Id & Client Id: [redacted]. Dear Shareholder(s), Sub: Unaudited Financial Results for the quarter and half year ended September 30, 2026. The Board of Directors, at its meeting held on Thursday, October 29, 2026, approved the Unaudited Financial Results (Consolidated and Standalone) of the Company.",
        authoredAt: "2026-10-30T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
        knownContact: true,
        senderRelationship: "weak · one-way inbound (you never replied) · not same-org",
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
        prodCategory: "action_needed",
      },
      {
        from: "BSE ALERTS <info@bseindia.in>",
        subject: "Funds / Securities Balance",
        body: "Dear Investor, With reference to BSE notices, Stock Brokers are required to upload segregation and monitoring of collateral at client level on daily basis. Your Stockbroker [redacted] BROKING LTD. has reported the details of Funds balance and Securities balance as on 30/09/2026 to Clearing Corporations, is attached. Please follow the procedure given below for opening the attachment. The password is your PAN in upper case. Please note that negative number in the file represents debit balance/balance payable by you.",
        authoredAt: "2026-10-17T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "payment",
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
        prodCategory: "action_needed",
        senderPrior: { key: "nse_alerts@nse.co.in", counts: {} },
      },
      {
        from: "nse_alerts <nse_alerts@nse.co.in>",
        subject: "Funds/Securities Balance",
        body: "Dear Investor, With reference to NSE circulars, Trading members are required to upload clients' securities balance on a daily basis. Information pertaining to your fund and securities balance provided by your trading member, along with the details of securities ISIN wise, is attached. Please follow the procedure given below for opening the attachment. The password is your PAN number in upper case.",
        authoredAt: "2026-10-30T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "fyi",
        senderPrior: { key: "nse_alerts@nse.co.in", counts: { fyi: 2, action_needed: 1 } },
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
        prodCategory: "payment",
        senderPrior: {
          key: "notifications@smallcase.com",
          counts: { fyi: 4, done: 2, action_needed: 5 },
        },
        senderKind: {
          kind: "service",
          confidence: 0.92,
          evidenceCodes: ["email:local:service_strong"],
        },
      },
      {
        from: "smallcase <notifications@smallcase.com>",
        subject: "Rebalance updates pending for your smallcase",
        body: "Pending Rebalance. Rebalance Update Available. You have rebalance update pending for your smallcase Growth & Value Multicap Model. Quarterly Update: the manager has updated the list of stocks/ETFs in this portfolio. See Update.",
        authoredAt: "2026-09-15T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
        senderPrior: { key: "notifications@smallcase.com", counts: {} },
      },
    ],
  },

  // ── The owner's own CI and deploys: quiet ─────────────────────────────────
  {
    label: "own-ci-and-deploy-failures",
    accept: ["fyi"],
    note: "Owner, 2026-11-07: alfred ships many PRs a day and he sees each failure in the PR, so even a failed alfred prod build is not loud. Blair is inactive, and a Polylane autofix PR started that deploy. His activity decides, not the sender.",
    mails: [
      {
        from: "Railway <hello@notify.railway.app>",
        subject: "Build failed for alfred",
        body: "Build failed! This is awkward. One of your builds failed to leave the wheelhouse. Details: Project: alfred. Service: server. Environment: production. View build logs.",
        authoredAt: "2026-11-03T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "urgent",
        senderPrior: { key: "hello@notify.railway.app", counts: { urgent: 3 } },
        senderKind: { kind: "service", confidence: 0.92, evidenceCodes: ["email:local:service"] },
      },
      {
        from: "Vercel <notifications@vercel.com>",
        subject: "Production deployment failed for blair",
        body: 'Production deployment failed. Hello, Yash. The production deployment for project blair failed on branch main at commit 0a3b055. Build error: Command "pnpm run build" exited with 1. Commit message: Merge pull request #11 from 99Yash/polylane/autofix/xws2fsihx0r1.',
        authoredAt: "2026-11-06T10:05:00Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
        senderPrior: { key: "service:vercel", counts: { marketing: 1, action_needed: 10 } },
        senderKind: {
          kind: "service",
          confidence: 0.92,
          evidenceCodes: ["email:local:service_strong"],
        },
      },
      {
        from: "Linear <notifications@linear.app>",
        subject: "Linear checks failed: feat(briefing): read the ADR-0118 activity record in ...",
        body: "You have 1 unread notification on Linear. Open your Inbox. Unsubscribe from these emails.",
        authoredAt: "2026-11-02T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
        senderPrior: { key: "notifications@linear.app", counts: { fyi: 2, action_needed: 5 } },
        senderKind: { kind: "group", confidence: 0.99, evidenceCodes: ["gmail:list_unsubscribe"] },
      },
      {
        from: "Yash Gourav Kar <notifications@github.com>",
        subject: "[99Yash/alfred] Run failed: ci - main (9fcac39)",
        body: "[99Yash/alfred] ci workflow run. Repository: 99Yash/alfred. Workflow: ci. Duration: 4 minutes and 50.0 seconds. Jobs: db-tests failed (2 annotations). logging-unit-tests succeeded. contracts-unit-tests succeeded. http-tests succeeded. static succeeded.",
        authoredAt: "2026-09-06T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
        senderPrior: { key: "notifications@github.com", counts: { action_needed: 7 } },
      },
      {
        from: "Yash Gourav Kar <notifications@github.com>",
        subject:
          "[99Yash/alfred] PR run failed: ci - fix(library): give the artifact viewer the chat rail's width",
        body: "[99Yash/alfred] ci workflow run. Repository: 99Yash/alfred. Workflow: ci. Duration: 3 minutes and 13.0 seconds. Jobs: unit-tests succeeded. db-tests succeeded. http-tests succeeded. duplicates succeeded. leaf-db-tests failed (3 annotations). assistant-unit-tests succeeded.",
        authoredAt: "2026-09-22T07:25:01Z",
        labelIds: UPDATES,
        prodCategory: "action_needed",
        senderPrior: {
          key: "notifications@github.com",
          counts: { fyi: 26, urgent: 1, action_needed: 26 },
        },
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
        prodCategory: "awaiting_reply",
        senderRelationship: "no prior contact on record",
      },
      {
        from: "Anand from AgentCall <hi@agentcall.dev>",
        subject: "thank you for your open-source work",
        body: "Hi Yash, Thank you for everything you've shared in open source. You came up on a list of developers whose public work a lot of people rely on, and I wanted to say thanks. We're a small, early-stage team. We built AgentCall, a skill that lets agents like Claude Code or Codex join a Google Meet, Zoom or Teams call.",
        authoredAt: "2026-11-02T08:00:00Z",
        labelIds: ["UNREAD", "CATEGORY_UPDATES", "SPAM"],
        prodCategory: "marketing",
        senderRelationship: "no prior contact on record",
      },
      {
        from: "Clera Talents <talent@getclera.com>",
        subject: "a quick hello from clera!",
        body: "Why you are hearing from us, and what happens next. Welcome to Clera. Let the right opportunities come to you. You may have first heard from someone working with Clera about an opportunity, rather than from Clera directly.",
        authoredAt: "2026-10-04T08:00:00Z",
        labelIds: UPDATES,
        prodCategory: "marketing",
        senderRelationship: "no prior contact on record",
      },
      {
        from: "Grace T. <g@tunebyalignerr.com>",
        subject: "Re: Software engineering opportunities at Alignerr",
        body: "Hi Yash, Just wanted to drop another quick note in case you're still looking for flexible, project-based work that fits your full-stack background. Our software engineering projects continue to be a strong fit for developers experienced in Next.js and TypeScript. If you'd like to pick up where you left off, you can complete your setup.",
        authoredAt: "2026-09-28T08:00:00Z",
        labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "INBOX"],
        prodCategory: "action_needed",
        knownContact: true,
        senderRelationship: "weak · one-way inbound (you never replied) · not same-org",
      },
    ],
  },
  {
    label: "newsletter-about-a-hack-is-not-a-security-alert",
    accept: ["newsletter", "marketing"],
    note: 'A job-board newsletter whose headline is about a hack. Nothing of the owner\'s is exposed. Prod said urgent through the security floor (`+floor`): its regex reads "No private key leaked" as a leak. Slice 3 must narrow that check.',
    mails: [
      {
        from: "JS Pulse <pulse@jsgurujobs.com>",
        subject: "The Binance Hack Started on One Laptop",
        body: "Think twice before you npm install a take-home. Plus 5 remote JS roles with salary and location. JS Pulse #9 from jsgurujobs.com. The Binance Hack Started on One Laptop. Binance links the breach to a compromised DevOps engineer's laptop that gave the attacker a path to a service container and the ability to submit unauthorized withdrawals. No private key leaked. This issue's sponsor slot is open.",
        authoredAt: "2026-11-02T08:00:00Z",
        labelIds: ["UNREAD", "CATEGORY_UPDATES", "SPAM"],
        prodCategory: "urgent",
        senderRelationship: "no prior contact on record",
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
        senderRelationship: "no prior contact on record",
        thread: { messageCount: 4, newestDirection: "sent" },
      },
    ],
  },

  // ── A real matter: loud ───────────────────────────────────────────────────
  {
    label: "railway-secrets-exposed-rotate",
    accept: ["urgent", "action_needed"],
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
];
