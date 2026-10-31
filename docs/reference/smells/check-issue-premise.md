---
id: check-issue-premise
section: Process
status: stays-review
rung: none
---

# Check the factual premise of an issue or plan against data before you write code.

Cite the query, log or commit.

Why: #1357 said that no Vercel mail reached Alfred, and a query found three.

## Bad

```text
This path has never run in production. No vercel.com mail reaches
Alfred's mailbox, so the trigger has had no input.
```

## Good

```text
Production findings (read-only, 2026-10-17): Gmail syncs the Vercel
"Deployment Failures" mails, and 3 mails match the trigger. The mail path
never ran because Vercel always has failed rows in the rotation.
```

## Mechanism

Not a fact in the code.

## Hits

- #1357 issue body: "No vercel.com mail reaches Alfred's mailbox"; a production query found 3 matching mails.
