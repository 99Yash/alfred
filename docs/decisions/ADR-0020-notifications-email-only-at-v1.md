# ADR-0020 — Notifications: email only at v1

**Decision.** External notifications go through email only (Resend). Morning briefing _is_ an email — the medium, not just an alert about it. Push, Slack DM, SMS, and other channels are deferred to a future ADR; the data shape leaves them open.

**In-app realtime alerts** ("alfred learned X", "approval pending") are handled by the existing realtime stack (SSE + Replicache poke + ephemeral toast events) — these don't need email. External delivery only happens for things the user wants pushed _to_ them when not actively using alfred (briefings, urgent approvals, summary digests).

**Schema.**

```
notification_preferences
  user_id, kind enum(briefing, approval, learned_fact, integration_alert, ...)
  channels      jsonb     -- ordered list with per-kind config
                          -- v1: only ['email'] supported
                          -- future: ['web_push', 'slack_dm', 'sms', 'email']

email_sends
  id, user_id, kind, idempotency_key (unique), to, subject, template, payload, sent_at, status, provider_message_id
```

A central `notify(user_id, kind, payload)` consults preferences and fans out. v1: `channels` is always `['email']`; later additions are matchers, not breaking changes.

**Why email-only:**

- Auth magic-link already requires Resend in the dependency tree (`@milkpod/auth` pulls it); zero new infra.
- Universally reliable, available on every device, doesn't require PWA install.
- Email is _itself useful_ (archive, search, reply) for things like the morning briefing — it's not just a transport.
- Web Push needs service-worker + VAPID + push-subscription lifecycle; real engineering for a feature that's nice-to-have at v1.

**Why future-proof the schema anyway:** the `notification_preferences.channels` jsonb means adding `web_push` or `slack_dm` later is a config change + a new fan-out branch in `notify()`, not a schema migration.

**Alternatives.**

- Web Push primary (deferred — engineering cost not justified at v1).
- SMS via Twilio (deferred — paid; HIL approval may eventually justify it).
- Slack/Telegram DM (deferred — depends on Slack integration being live first).
