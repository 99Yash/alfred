# Research: how to make a frozen-weight model write like one specific person (outbound email)

**Date:** 2026-08-28
**Question:** Alfred calls Claude through the Anthropic API. The weights are frozen. How does Alfred make the prose sound like Yash for outbound email, not only "less slop"?
**Method:** primary sources only. Vendor documentation pages (platform.claude.com, developers.openai.com, model-spec.openai.com, docs.cloud.google.com, aws.amazon.com), arXiv papers read directly (PDF text extracted where the HTML was unavailable), and `path:line` for repo claims. Vendor guidance is labeled as guidance, not as measurement. Absent evidence is written as "no primary evidence found".
**Scope note:** the structural argument about `packages/ai/src/voice/` is already made in the main session. This file carries the external evidence and the measurement plan.

## 1. Summary

**The short answer.** On a frozen-weight API model, the only lever with a large measured effect is **retrieved exemplars written by the user**. On email specifically, zero-shot retrieval of the user's own past mail moves ROUGE-1 from 0.362 to 0.482 on subject generation ([LaMP](https://arxiv.org/abs/2304.11406), Table 4) and from 0.1773 to 0.3490 on full bodies ([LongLaMP](https://arxiv.org/abs/2407.11016)). Nothing else on the list comes close, and most of the rest is not available at all.

**Six findings that change the plan:**

1. **The denylist is a weak proxy for the goal.** A pre-registered experiment with 1,822 ratings found that removing the classic AI focal words produced **no significant change in human preference**; only `delve` in the first sentence was significant (`p = 0.023`), and for other focal words readers slightly preferred the versions **with** the words ([arXiv:2412.11385](https://arxiv.org/html/2412.11385v1)). The entire current design rests on the assumption that these are the same thing. They are measurably not. See section 8.1.
2. **The repo already has the substrate, and it is dormant.** `style_profiles` exists (`packages/db/src/schema/memory.ts:187`), keyed `(channel, audience_bucket, recipient_id)` exactly as this file would recommend, with CRUD and precedence implemented (`packages/assistant/src/knowledge/style-profiles.ts`). **Production callers: zero.** ADR-0013 designed it and parked it until "something actually drafts on the user's behalf". `gmail.send_draft` is that thing now. See section 5.1.
3. **The retrieval pipeline also already exists.** Ingested Gmail is chunked and embedded into `chunks` with a 1024-dimension vector (`packages/db/src/schema/documents.ts:131`), and `packages/corpus/src/search.ts:69` already runs the cosine query. The gap is a sent-only filter, whose predicate is already written (`gmailSentSql()`, `packages/assistant/src/triage/sent-mail.ts:83`). See section 10.1.
4. **A static voice card is worth about nothing.** Measured on the same Avocado email corpus: a context-independent summary of the user scored Bleu 21.23 against retrieval-only's 21.19. A **draft-conditioned** summary scored 23.17 ([arXiv:2308.07968](https://arxiv.org/abs/2308.07968), Table 2). "Distil a style guide once and reuse it" is the version that does not work. See section 5.2.
5. **Three levers are simply gone.** Prefill returns a **400** on Claude 4.6 and later, and Alfred runs `claude-sonnet-4-6` and `claude-opus-4-8`. `temperature` and `top_p` are **deprecated** after Claude Opus 4.6. There is **no fine-tuning on the Claude API**; the only Claude fine-tuning anywhere is Claude 3 Haiku on Bedrock in `us-west-2`, GA since 2024-11. See sections 3.4, 7.4, 6.1.
6. **The cache objection is real but cheap to satisfy, and the current `grounding` slot does not satisfy it.** `decorateAnthropicPrompt` (`packages/ai/src/request-projection.ts:86`) puts one breakpoint on the whole system message, so per-run text appended through `grounding` invalidates the entire system block, about **12.5x** the cached cost. Put the exemplars in the first **user** message instead: about **$0.003** per draft, with tools and system still cached. See section 4.5.

**Both vendors say the same thing about prompts, and neither publishes a number.** Anthropic: "Tell Claude what to do instead of what not to do", and "Provide examples of your desired output. This is more effective than abstract instructions." OpenAI ships DPO and names "Generating chat messages with the right tone and style" as its lead use case. All of that is first-party guidance, not measurement. See section 3.

**Build order.** The held-out sent-mail eval first, because nothing else is attributable without it. Then the sent-mail exemplar block. Then the positive rewrite of `DEFAULT_VOICE_PROMPT`. Then activate `style_profiles`, filling `examples` before `profile_doc`. Best-of-N and any tuned rewriter stay below the line until the eval can prove they help.


## 2. Why AI prose reads as AI (measured)

This section decides which knobs matter. Four effects have primary measurement. A fifth is folklore.

### 2.1 Lexical over-representation is real and it is a STYLE effect, not a content effect

Kobak, Marquez, Horvat and Lause, "Delving into LLM-assisted writing in biomedical publications through excess vocabulary" ([arXiv:2406.07016](https://arxiv.org/abs/2406.07016), published in *Science Advances* 11(27), 2025-07-02). Corpus: over 15 million PubMed abstracts, 2010-2024. Method: "excess word" analysis, which compares the observed 2024 frequency of each word against a counterfactual extrapolated from earlier years.

Measured results ([arXiv:2406.07016](https://arxiv.org/html/2406.07016)):

- **454 excess words in 2024** (343 unique lemmas), against 190 in 2021 at the peak of the Covid literature.
- The 2021 excess vocabulary was **almost entirely content words** (`respiratory`, `remdesivir`). The 2024 excess vocabulary is **almost entirely style words**.
- Part of speech split of the 2024 excess words: **66% verbs, 14% adjectives**. Before 2024 the excess words were **79.2% nouns**.
- Frequency ratio `r` for rare marker words: `delves` r=28.0, `underscores` r=13.8, `showcasing` r=10.7. Frequency gap for common marker words: `potential` delta=0.052, `findings` delta=0.041, `crucial` delta=0.037.
- Lower bound estimate: **at least 13.5% of 2024 abstracts** were processed with an LLM, up to 40% in some subcorpora.

**What this licenses.** A denylist of specific tokens is attacking a real, measured signal. The signal is lexical and it is style-carrying. `detectAiTells` at `packages/ai/src/voice/voice-detector.ts:225` is therefore not superstition.

**What this does NOT license.** The paper measures *detection*, not *perception*. It shows that these words identify machine involvement. It does not show that a text with the words removed reads as human. See section 8.5.

### 2.2 The cause is probably alignment, and nobody has proved it

Juzek and Ward, "Why Does ChatGPT 'Delve' So Much? Exploring the Sources of Lexical Overrepresentation in Large Language Models" ([arXiv:2412.11385](https://arxiv.org/abs/2412.11385)). They isolate 21 focal words. Their stated finding:

> "We fail to find evidence that lexical overrepresentation is caused by model architecture, algorithm choices, or training data."

They test RLHF as the remaining explanation and report the model testing is "consistent with RLHF playing a role", but their human participants react differently to `delve` than to the other focal words, so the attribution stays open. They name the absence of transparency in model development as the obstacle.

**Consequence for Alfred.** The tics come from the alignment layer, not from the corpus. A prompt cannot remove an alignment prior. It can only ask the model to fight its own prior on each token. That is why a denylist decays under long output and needs a deterministic backstop, which is exactly what `packages/ai/src/voice/voice-sanitize.ts` is.

### 2.3 Uniform sentence length and low lexical variety

Munoz-Ortiz, Gomez-Rodriguez and Vilares, "Contrasting Linguistic Patterns in Human and LLM-Generated News Text" ([arXiv:2308.09067](https://arxiv.org/abs/2308.09067)). Measured, on parallel human and LLM news text:

> "Human texts exhibit more scattered sentence length distributions, more variety of vocabulary, a distinct use of dependency and constituent types, shorter constituents, and more optimized dependency distances."

Other measured differences in the same paper: LLMs use proportionally more numbers and symbols, more auxiliary verbs, and more pronouns. Human text carries stronger negative emotion (fear, disgust) and less joy. The authors also report that the gap between humans and LLMs is larger than the gap between LLMs, which means these are alignment-family traits and not model-specific traits.

**Consequence.** Sentence-length variance is a measurable, model-independent axis, and no part of `packages/ai/src/voice/` measures it. `detectAiTells` counts tokens. It does not count rhythm.

### 2.4 Sycophancy and positivity bias come from the preference data

Sharma et al., "Towards Understanding Sycophancy in Language Models" ([arXiv:2310.13548](https://arxiv.org/abs/2310.13548), ICLR 2024). They show five RLHF assistants are sycophantic across varied text-generation tasks, and they trace the behavior to the human preference data itself: in existing pairwise preference sets, a response that matches the user's stated view is more likely to be preferred. Optimization against such a preference model therefore selects for agreement.

**Consequence for outbound email.** The flattery rule and the hedge rule in `DEFAULT_VOICE_PROMPT` (`packages/ai/src/voice/prompt.ts:15`) fight a trained prior, not an accident. The same result predicts the failure mode of a judge-guided loop, see section 7.1.

### 2.5 "Perplexity and burstiness" is a vendor framing, not a measured claim

GPTZero defines perplexity as "a measure of how likely an AI model would have chosen the exact same set of words as found in the document" and burstiness as "a measure of how much writing patterns and text perplexities vary over the entire document" ([gptzero.me](https://gptzero.me/news/perplexity-and-burstiness-what-is-it/)). The page carries **no accuracy numbers, no benchmark, and no validation data**. It also states that the product has moved away from these statistics toward a deep-learning detector.

Label this **vendor claim / folklore**. The underlying quantity (variance of sentence length) is measured in 2.3 by a peer-reviewed source. The GPTZero framing is not itself evidence.


## 3. Prompt-level style specification

### 3.1 Anthropic says the opposite of what `DEFAULT_VOICE_PROMPT` does

Anthropic's living prompt reference is [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). It covers Claude Opus 5, Opus 4.8, Sonnet 5 and Sonnet 4.6. Alfred routes to `claude-opus-4-8` and `claude-sonnet-4-6` (`packages/ai/src/models.ts:46`, `packages/ai/src/models.ts:57`, `packages/ai/src/provider.ts:43`), so this page is the page that applies.

Three verbatim rules from the "Control the format of responses" section:

> **1. Tell Claude what to do instead of what not to do**
> * Instead of: "Do not use markdown in your response"
> * Try: "Your response should be composed of smoothly flowing prose paragraphs."

> **3. Match your prompt style to the desired output**
> The formatting style used in your prompt may influence Claude's response style. If you are still experiencing steerability issues with output formatting, try matching your prompt style to your desired output style as closely as possible.

From "Add context to improve performance", with the example pair:

> **Less effective:** `NEVER use ellipses`
> **More effective:** `Your response will be read aloud by a text-to-speech engine, so never use ellipses since the text-to-speech engine will not know how to pronounce them.`
> Claude is smart enough to generalize from the explanation.

`DEFAULT_VOICE_PROMPT` at `packages/ai/src/voice/prompt.ts:15` is seven rules, and five of the seven are pure prohibition ("Remove filler, flattery, hype…", "No em-dashes", "Skip emoji"). It gives no reason for any rule. It is written in the exact "Less effective" shape that Anthropic's own page names.

Two of the seven rules are positive and they are the two that are also the most specific: the "Start with the answer" rule, and the concrete-phrasing rule that carries two sample sentences. The document is therefore not uniformly wrong. It is thin in the positive direction and thick in the negative direction, and the vendor guidance says to invert that ratio.

**Status of this evidence: first-party vendor guidance. It is NOT a measured comparison.** Anthropic publishes no A/B number for positive style description against a banned-phrase list. No primary evidence found for such a measurement from any vendor.

### 3.2 Examples beat abstract instruction, per the vendor

Same page, "Use examples effectively":

> Examples are one of the most reliable ways to steer Claude's output format, tone, and structure. A few well-crafted examples (known as few-shot or multishot prompting) improve accuracy and consistency.

Criteria given: **Relevant** ("Mirror your actual use case closely"), **Diverse** ("Cover edge cases and vary enough that Claude doesn't pick up unintended patterns"), **Structured** (wrap in `<example>` tags inside `<examples>`). The count guidance is explicit:

> Include 3–5 examples for best results.

The guardrails page [Increase output consistency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/increase-consistency) is blunter under "Constrain with examples":

> Provide examples of your desired output. This is more effective than abstract instructions.

Again: **vendor guidance, no number attached.** But note that it names `tone` explicitly, and the claim is comparative. This is the strongest first-party statement available on the exact question this file asks.

### 3.3 Role and character

Same best-practices page, "Give Claude a role":

> Setting a role in the system prompt focuses Claude's behavior and tone for your use case. Even a single sentence makes a difference.

[Increase output consistency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/increase-consistency), "Keep Claude in character":

> When setting up the character, provide detailed information about the personality, background, and any specific traits or quirks. This helps the model better emulate and generalize the character's traits.

Note the direction of that sentence. It asks for a **description of a person**. `composeAgentInstructions` at `packages/ai/src/voice/instructions.ts:27` accepts `role`, so the seam has a slot for it, but `VoicePolicy = "default" | "none"` gives the voice slot no place to carry a person.

### 3.4 Prefill is DEAD for the models Alfred uses

This contradicts the plan. Prefill of the assistant turn is a classic style-lock trick, and it is no longer available.

From [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), section "Migrating away from prefilled responses":

> Starting with Claude 4.6 models and Claude Mythos Preview, prefilled responses (providing a partial assistant message for Claude to continue from) on the last assistant turn are no longer supported. Requests with prefilled assistant messages to these models return a 400 error.

The consistency page repeats it:

> Prefilling is not supported on Claude 4.6 and later models.

Alfred's two chat models are `claude-sonnet-4-6` and `claude-opus-4-8` (`packages/ai/src/provider.ts:43`, `packages/ai/src/provider.ts:71`). Both are 4.6 or later. **Prefill returns a 400 for Alfred. Remove it from the option list.**

The vendor's stated replacement for the "skip the preamble" use of prefill is plain system-prompt instruction, which is what `DEFAULT_VOICE_PROMPT` already does with its "Start with the answer" rule.

### 3.5 OpenAI, for comparison

The [OpenAI text generation guide](https://developers.openai.com/api/docs/guides/text) carries only one style demonstration, the string `Talk like a pirate` in the `instructions` parameter example. It gives **no measured evidence**, no comparison of instruction styles, and no few-shot style data.

The [OpenAI Model Spec (2026/08/18)](https://model-spec.openai.com/2026-08-18.html) is more interesting because it makes style a distinct authority class. Style, tone, formatting and initiative sit at **guideline** level, which the spec says may be overridden **implicitly**, from context or user history. Truthfulness and objectivity sit at **user-default** level and need an explicit override. So OpenAI's own policy treats style as the softest, most steerable layer of the stack, and treats prior user context as a legitimate source of style override.

**Conclusion for Alfred.** Both vendors agree that style is highly steerable at the prompt layer and that examples steer it better than adjectives do. Neither vendor publishes a number.

### 3.6 Does "principles over exemplars" hold for style?

The repo heuristic ("classifier/prompt fixes lead with rubric; exemplars only at boundaries") comes from classification work, where the exemplars were being used to patch a rubric gap.

For style the vendor guidance points the other way, and there is a reason to believe the heuristic does not transfer. A classification rubric has a decision boundary that words can name: `service` versus `person` is expressible. A voice has no boundary to name. The target is a **distribution** over lexical choice, sentence length, punctuation, and greeting form. Prose cannot express a distribution; a sample can.

This is an argument, not a measurement. But section 4 supplies the measured half, and it points the same way.


## 4. Few-shot from the user's own sent mail

This is the axis with real measured lift, and it is the axis where Alfred already owns the data.

### 4.1 LaMP: retrieved user-authored exemplars, measured on an EMAIL task

Salemi, Mysore, Bendersky and Zamani, "LaMP: When Large Language Models Meet Personalization" ([arXiv:2304.11406](https://arxiv.org/abs/2304.11406)). Seven tasks. Task 6 is **Personalized Email Subject Generation** on the Avocado Research Email Collection, a private corpus that the authors chose because "Given its private nature this is unlikely to be contained in pre-training data" (paper, LaMP-6 task description).

The method is exactly the one Alfred can run: a retriever picks `k` items from the user's own profile, and a prompt-construction function concatenates the instruction, the input, and the retrieved items. No weight change.

**Table 2, fine-tuned FlanT5-base, user-based split, LaMP-6U, ROUGE-1 / ROUGE-L:**

| Condition | ROUGE-1 | ROUGE-L |
|---|---|---|
| No-Retrieval (non-personalized) | 0.379 | 0.358 |
| Random item from ALL users' profiles | 0.473 | 0.457 |
| Random item from the USER's own profile | 0.486 | 0.470 |
| BM25, k=1 | **0.586** | **0.570** |
| Contriever, k=1 | 0.572 | 0.558 |
| IPA (tuned profile) | 0.587 | 0.575 |
| FiD, k=16 | 0.567 | 0.555 |

Two readings matter.

1. **Any of the user's own mail is worth a lot.** 0.379 to 0.486 is +28% relative for a single **random** item from the user's profile.
2. **Choosing the right one is worth a lot more.** 0.486 to 0.586 is a further **+20.6% relative** for BM25 selection over random selection inside the same corpus. Retrieval quality is not a rounding error.

**Table 4, ZERO-SHOT, which is Alfred's actual setting (frozen weights):** LaMP-6, user-based split, FlanT5-XXL. Non-personalized ROUGE-1 **0.362**, personalized **0.482**. ROUGE-L **0.343** to **0.471**. That is **+33% ROUGE-1 and +37% ROUGE-L with no training at all**.

Note a detail with a privacy lesson attached: the GPT-3.5 column for LaMP-6 is `-` in both splits of Table 4. The authors did not send the private email corpus to a third-party API. See section 10 on privacy.

**Retriever choice, verbatim from the paper:**

> For Email Generation and Scholarly Title Generation tasks (LaMP-5U and LaMP-6U), BM25 demonstrates superior performance. Both BM25 and Contriever outperform a random profile selector in all LaMP datasets.

> Generally, the results indicate that incorporating any information from the user profile into the input is not sufficient, but rather selecting the most relevant and/or recent information is crucial.

> There is no clear winner among the retrieval models we study and an ensemble of relevance and temporal signals for personalization should be studied in the future.

**Recency versus semantic similarity, measured.** Recency loses on the email task. The `Recency` column appears only in the time-based split. On LaMP-6T (Table 3) it scores ROUGE-1 **0.532** against Contriever's **0.545** and BM25's **0.537**, with No-Retrieval at 0.479. The paper also reports that recency beats Contriever on only one classification task (LaMP-3T) and on only one generation task (LaMP-4T, News Headline Generation). So for email, **similarity to the draft beats "most recent sent mail"**. That contradicts the cheapest possible implementation, which would be "take the last five sent emails". Section 5.4 gives the counterweight.

**Caveat that must not be skipped.** ROUGE measures n-gram overlap against a ground-truth subject line. High ROUGE reflects both content match and phrasing match. It is **not** a style metric. LaMP proves that user-authored exemplars make the output closer to what the user actually wrote. It does not prove that a human reader judges the output as more human. See section 8.

### 4.2 LongLaMP: the same result on full email BODIES

Kumar, Salemi, Mysore et al., "LongLaMP: A Benchmark for Personalized Long-form Text Generation" ([arXiv:2407.11016](https://arxiv.org/abs/2407.11016)). Four tasks. Task 1 is **Personalized Email Completion**, again on the Avocado Research Email Collection: **279 users** after filtering, and **3,286 train / 958 validation / 823 test** cases in the user split (Table 1).

This matters more than LaMP for Alfred, because the unit is a **body**. Table 1 of the paper gives the email task an average output length of **92.59 +/- 60.68 tokens** and an average profile size of **85.65 +/- 51.67 items per user**.

**Personalized Email Completion, ZERO-SHOT LLaMA2, non-personalized against retrieval-personalized.** Table 2 is the user split, Table 3 is the temporal split. Both use Contriever with **k = 4**.

| Split | Metric | Non-personalized | Personalized | Relative |
|---|---|---|---|---|
| User (Table 2) | ROUGE-1 | 0.1773 | 0.3490 | +96.8% |
| User (Table 2) | ROUGE-L | 0.1111 | 0.2993 | +169% |
| User (Table 2) | METEOR | 0.1605 | 0.3495 | +118% |
| Temporal (Table 3) | ROUGE-1 | 0.1825 | 0.3127 | +71.3% |
| Temporal (Table 3) | ROUGE-L | 0.1159 | 0.2563 | +121% |
| Temporal (Table 3) | METEOR | 0.1622 | 0.2997 | +84.8% |

The fine-tuned FlanT5-base results (Table 4) move the same way: temporal split ROUGE-1 **0.2356 to 0.3997**, ROUGE-L **0.1944 to 0.3615**.

**The GPT-3.5 column is `-` for the email task in every table.** As in LaMP, the authors did not send the private Avocado corpus to a third-party API. That is the second time a research group made the same privacy call on the same data.

The paper reports "an improvement between 5.7% to 128% across various metrics" across the benchmark, and an average of **30.21% on ROUGE-1 and 47.5% on ROUGE-L across all tasks**. The email task sits well above that average.

**Number of exemplars, measured.** For Email Completion, "Contriever emerges as the top retriever with **4 retrieved profile entries**" in both splits. Compare that with Anthropic's own guidance of "3–5 examples for best results" ([Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)). The two agree. **k = 4 is the number to build.**

Note the disagreement between the two papers on the retriever: BM25 wins on LaMP-6 (subject lines), Contriever wins on LongLaMP email bodies. A reasonable reading is that short subject lines favor lexical overlap and long bodies favor semantic match. Alfred drafts bodies, so a semantic retriever is the better default, and the repo already runs embedding retrieval over `documents`.

### 4.3 Per-recipient register: measured only in a user study

The hypothesis is that a person writes differently to their manager than to a vendor, so exemplars should be filtered to the same recipient or the same relationship class.

**No primary evidence found** that measures per-recipient retrieval against user-level retrieval on an automated benchmark. LaMP and LongLaMP both retrieve from a flat per-user profile with no recipient conditioning.

The closest primary source is a system paper: "PersonaMail: Learning and Adapting Personal Communication Preferences for Context-Aware Email Writing" ([arXiv:2602.17340](https://arxiv.org/html/2602.17340)). Its central object is a **Persona-Situation Anchor**, a saved factor configuration tied either to a recipient relationship (Persona) or to a communication context (Situation), reapplied to new scenarios. It also carries an **Adaptive Stylebook** that learns from the user's edits and stores the modification with its rationale.

Measured, 16 participants, 7-point scale:

| Metric | PersonaMail | Baseline | Result |
|---|---|---|---|
| First draft quality | 5.81 | 4.31 | p<0.001 |
| Revised draft quality | 6.94 | 6.12 | p=0.002 |
| Cognitive load (NASA-TLX) | 3.91 | 5.18 | p<0.001 |
| Total time on reuse | 8m55s | 15m24s | p<0.001 |

**Read this carefully.** N=16 is a lab study, self-rated, and the compared baseline is a generic LLM composer, not a user-exemplar composer. It supports the claim that recipient-conditioned and context-conditioned configuration helps a human get to a good email faster. It does **not** measure per-recipient retrieval against user-level retrieval, and it does not measure whether the output reads as the user.

**Verdict for Alfred.** Per-recipient conditioning is well motivated and cheap, but its lift is **unmeasured**. Do not build it before the eval in section 8 exists, because there would be nothing to attribute the change to.

### 4.4 Greeting, sign-off, length: no primary evidence found

The plan asked for measured evidence on greeting and sign-off imitation, on length distribution match, and on reply against cold-send. **No primary evidence found** in a peer-reviewed or vendor source that isolates these sub-features. LongLaMP's email task scores the whole body with ROUGE and METEOR, which folds greeting, sign-off, and length into one number.

This is an argument to make them **deterministic** rather than modeled. A greeting inventory and a sign-off inventory extracted from sent mail are countable facts, not judgments, and countable facts can be scored deterministically in the evalite lane. See section 8.6.

### 4.5 Prompt cache interaction, priced

The parent asked what a per-run exemplar block actually costs. The answer depends on **where** the block is placed, and the repo's own projection code decides that.

**The Anthropic rules** ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)):

- Maximum **4** `cache_control` breakpoints per request.
- Minimum cacheable prompt length: **1,024 tokens** for Claude Sonnet 4.6 and Claude Opus 4.8. "Shorter prompts cannot be cached, even if marked with `cache_control`. Any requests to cache fewer than this number of tokens will be processed without caching, and no error is returned."
- Default TTL 5 minutes. A 1-hour TTL is available with `{"cache_control": {"type": "ephemeral", "ttl": "1h"}}`.
- Multipliers: 5-minute write **1.25x** base input, 1-hour write **2x** base input, cache read **0.1x** base input.
- Invalidation is hierarchical: tools, then system, then messages. "Changes at each level invalidate that level and all subsequent levels."

**The Alfred rules:**

- Prices for the two models Alfred uses: `claude-sonnet-4-6` is $3 / MTok input, $15 / MTok output, $0.30 / MTok cache read, $3.75 / MTok 5-minute cache write. `claude-opus-4-8` is $5 / MTok input, $25 / MTok output, $0.50 / MTok cache read.
- `DEFAULT_VOICE_PROMPT` is about **327 tokens** (1,307 characters in the literal at `packages/ai/src/voice/prompt.ts:15`, at roughly 4 characters per token). **It is far below the 1,024-token cache minimum on its own.** It is only ever cached as part of a larger system block. The comment at `packages/ai/src/voice/prompt.ts:8` that says "It stays static so callers with prompt caching can reuse it" is therefore true only at the level of the whole system string.
- `composeAgentInstructions` returns **one joined string** (`packages/ai/src/voice/instructions.ts:33`). `decorateAnthropicPrompt` at `packages/ai/src/request-projection.ts:86` puts one `cache_control` breakpoint on `prompt[0]` when it is the system message. **The whole system prompt is a single cache block.**

**Consequence, and it is the load-bearing one.** The existing `grounding` slot (`packages/ai/src/voice/instructions.ts:22`, documented as "Per-run grounding, ordered last so stable prompt prefixes remain cacheable") does **not** protect the cache today, because there is no second breakpoint inside the system string. Any per-run text appended through `grounding` changes byte 0-to-end of the single cached system block and forces a full re-write of it.

**The cost of getting it wrong (exemplars in the system prompt).** Assume a chat system prompt near 4,000 tokens on Sonnet 4.6.
- Cached: 4,000 x $0.30 / MTok = **$0.0012** per request.
- Invalidated and rewritten each turn: 4,000 x $3.75 / MTok = **$0.015** per request. About **12.5x** the cached cost.

**The cost of getting it right (exemplars in the first user message).** Four sent emails at about 250 tokens each is about **1,000 tokens**.
- Uncached input on Sonnet 4.6: 1,000 x $3 / MTok = **$0.003** per draft.
- The tools block and the system block stay cached, because messages sit below system in the invalidation hierarchy.

**So the honest price of retrieved exemplars for an email draft is about a third of a cent, and the cache stays intact, provided the block goes in a message and not in the system prompt.** The dash-rule and the static voice prompt lose nothing.

Two secondary costs are real:
- **Latency.** One retrieval query against the `documents` table plus an embedding of the draft context. This is one database round trip, not a model call, if the embeddings are precomputed at ingest. Single-digit milliseconds to low tens of milliseconds, against a multi-second model call. Not material.
- **Breakpoint budget.** Alfred already runs at the 4-breakpoint cap: `decorateAnthropicTools` takes one, and `decorateAnthropicPrompt` takes up to three (system, tool-burst boundary, last message). `packages/assistant/src/chat/chat-turn.ts:597` exists precisely to surface the Anthropic "cacheControl breakpoint limit" warning when the cap is exceeded. **Adding a fifth breakpoint for an exemplar block would silently drop the tool-definitions cache block.** Any implementation must reuse the existing last-message breakpoint, not add one.


## 5. Style profile / voice card extraction

The idea: instead of shipping raw sent emails on each call, distil one persisted description of how the person writes, and ship that.

### 5.1 THE REPO ALREADY HAS THIS TABLE, AND IT IS DORMANT

This is the largest repo finding in this file, and the main session does not have it.

`docs/decisions/ADR-0013-style-profiles-dedicated-table-channel-audience.md` already decided the exact object:

> Dedicated `style_profiles` table. Each row = `(channel, audience_bucket, optional recipient_id) → profile_doc + few-shot examples + provenance`.

The table exists at `packages/db/src/schema/memory.ts:187`. The primitives exist at `packages/assistant/src/knowledge/style-profiles.ts`, 222 lines: `upsertStyleProfile` (`style-profiles.ts:107`) and `getStyleProfile` (`style-profiles.ts:178`), with the ADR-0013 precedence already implemented (`recipientId` beats `audienceBucket` beats `generic`, `style-profiles.ts:203`). The enums exist at `packages/assistant/src/knowledge/types.ts:25` (`STYLE_CHANNELS`, 7 values including `gmail`) and `packages/assistant/src/knowledge/types.ts:38` (`STYLE_AUDIENCE_BUCKETS`: `family, friend, peer, manager, customer, vendor, public, generic`).

**Production callers: zero.** A repository-wide search for `getStyleProfile` and `upsertStyleProfile` finds only `packages/assistant/test/knowledge/derived-persistence-schemas.test.ts:6`, which is a schema test. The module's own header comment says why (`packages/assistant/src/knowledge/style-profiles.ts:17`):

> Style-profile primitives are intentionally minimal in m8a — table CRUD only. ADR-0013's full lifecycle (lazy materialization, audience-bucket inference from `user_facts`, regeneration on source deletion) lands when something actually drafts on the user's behalf (m9 reply drafting, ADR-0025 #5 OFF-by-default).

**And `gmail.send_draft` at `packages/assistant/src/tool-runtime/internal/tools/gmail.ts:288` is now exactly that thing.** Alfred drafts on the user's behalf today, and the trigger condition written into the comment is met. The substrate is not missing. The wire is missing.

ADR-0013 also carries two claims that the literature now confirms or corrects:

> **Why both `profile_doc` and `examples`:** doc tells the LLM _what_ the style is in words; few-shot examples in the prompt outperform a written guide for actual style transfer. Use both: doc as instructions, examples as evidence.

That "examples outperform a written guide" claim is uncited in the ADR. Section 5.2 supplies the primary evidence, and it is stronger and more specific than the ADR states.

> Distilled profile + RAG examples replaces both fine-tuning (privacy risk: corpus leaves to OpenAI/Anthropic) and full-corpus per-call RAG (cost + variability).

The privacy premise is correct in direction but the arithmetic in section 4.5 shows the "cost" objection to per-call retrieval is roughly a third of a cent per draft.

### 5.2 MEASURED: a STATIC style guide adds nothing; a QUERY-CONDITIONED one does

Li, Zhang, Luo, Chang et al. (Google), "Teach LLMs to Personalize — An Approach inspired by Writing Education" ([arXiv:2308.07968](https://arxiv.org/abs/2308.07968)). A five-stage pipeline: retrieval, ranking, summarization, synthesis, generation. It is evaluated on three corpora, and **one of them is the Avocado email corpus**, the same email data as LaMP-6 and LongLaMP.

Table 2, Avocado email, all values are percentages:

| Method | Bleu | Rouge-1 | Rouge-2 | Rouge-L |
|---|---|---|---|---|
| `ImmedCtx` (no user history at all) | 17.27 | 32.36 | 21.45 | 28.58 |
| `UserID` (user identity only, no text) | 13.28 | 32.33 | 20.95 | 27.86 |
| `LLMZeroShot` (PaLM 2, given the best input) | 14.93 | 35.06 | 22.11 | 28.52 |
| `RecentDoc` (most recent past documents) | 19.57 | 35.64 | 23.96 | 31.25 |
| `RankDocBM25` (best retrieval) | 21.19 | 37.69 | 25.99 | 33.07 |
| `SumCtxInd` (**context-INdependent** summary of the user, i.e. a static voice card) | 21.23 | 37.58 | 25.79 | 33.15 |
| `SumCtx` (**context-dependent** summary) | 23.17 | 39.31 | 26.64 | 34.37 |
| `SynCtx` (+ context-dependent synthesis) | 23.44 | 40.38 | 26.93 | 34.34 |
| `AuthorPred` (+ multitask author distinction) | 23.27 | **41.02** | **28.60** | **35.70** |

The authors state the result directly:

> SumCtxInd performs similarly as retrieval augmented methods without the summarization step, while SumCtx outperforms retrieval augmented methods. This indicates that a generic summary does not provide additional information to the generation model. The summary is more useful when it considers the immediate context.

**This is the sharpest finding in this file, and it contradicts the obvious plan.** A persisted, static "here is how Yash writes" document, generated once and reused, is `SumCtxInd`. On email it moved Bleu from 21.19 to 21.23 and Rouge-L from 33.07 to 33.15. That is **noise**. The gain came only when the summary was conditioned on the specific message being written.

So a `profile_doc` in `style_profiles` is not free lift. To pay for itself it must either be conditioned on the draft, or be split so narrowly by `(channel, audience_bucket, recipient_id)` that the row itself is effectively context. ADR-0013's key **already has** that split, which is the correct instinct, but the split is untested.

### 5.3 A second measured result: the author-distinction auxiliary task

The best Rouge-1 row on Avocado email is `AuthorPred`, 41.02 against `SynCtx`'s 40.38. `AuthorPred` adds a multitask objective in which the model must judge whether a candidate document was written by the same author. That is a **discriminator signal** wired in at training time. Section 7.2 asks whether the same signal can be used at sampling time by a frozen model.

Alfred cannot use `AuthorPred` directly, because it is a training objective and Alfred's weights are frozen. It is listed because it is evidence that the "did Yash write this?" signal carries real information about voice.

### 5.4 Recency is a fair second-best on email specifically

The same paper, on the same email corpus:

> RecentDoc unexpectedly performs on par with some similarity based retrieval methods in many cases, especially on the Avocado email dataset. But it still performs worse than RankDocBySnpt.

`RecentDoc` scores 19.57 Bleu against `RankDocBM25`'s 21.19. It beats the no-history baseline of 17.27 by a wide margin. This softens the LaMP result in section 4.1. Reading both papers together: **recency is a cheap and honest starting point on email, and similarity retrieval is measurably better.** Alfred should ship similarity, but a recency fallback for a cold recipient is defensible.

### 5.5 A method comparison that looks contradictory and is not

"APM: Evaluating Style Personalization in LLMs with Arbitrary Preference Mappings" ([arXiv:2605.21063](https://arxiv.org/html/2605.21063v1)) reports that **Routing** (train a classifier to predict a discrete style label from the user's history, then insert a style instruction in the system prompt) beats **RAG**. On Qwen-3.5-27B with one active attribute, Routing reaches a win/loss ratio of **1.79** and Delta **+1.11**; `RAG-Summary` reaches **1.16** and **+0.26**; prompt optimization is about **1.0**, that is, no effect. The routing oracle upper bound is 2.88 / +1.93.

**Do not cite this as evidence against exemplars.** Verified against the paper: its RAG baselines retrieve over **other users**, not the user's own history. `RAG-Exemplar` retrieves "the k=3 nearest training users by text encoder similarity". So APM compares two cold-start strategies for inferring a stranger's preference. It is not the LaMP setting, where the exemplars are the user's own writing. Alfred has the user's own writing.

Two further limits, stated by the authors: the conversation data is **synthetic**, and the evaluation is an **LLM judge** (gpt-oss-120b, 1 to 10 scale). They also report "consistent small drops in general capabilities and demographic fairness across all personalization methods".

The one transferable point: a **discrete, classified style label** injected as an instruction is a working mechanism, and it costs almost no tokens. That is what `audience_bucket` is in ADR-0013.

### 5.6 Corpus size

**No primary evidence found** for a threshold of the form "N sent emails are enough to induce a usable style profile".

What the papers do state is their inclusion filter, not a measured floor. LongLaMP built its email task by "selecting only those with a sending frequency of **10 to 200 emails**", which produced 279 users with an average profile size of **85.65 +/- 51.67** items ([arXiv:2407.11016](https://arxiv.org/abs/2407.11016), Table 1). LaMP tunes `k` per task and reports no corpus-size curve.

So the published work assumes tens of documents per user and never measures the floor. For Alfred this is a reason to make the eval report the corpus size it drew from, so the floor can be measured on real data instead of guessed.

### 5.7 Where a style profile would live in Alfred's substrate

`style_profiles` is its own table (`packages/db/src/schema/memory.ts:187`), not the observation log. That is the right placement and it should stay there. ADR-0080 (`docs/decisions/ADR-0080-...:1`) makes identity facts a **deterministic projection** over the ADR-0067 `observations` log under the rule "**No grounding, no row** — the projection never materializes a value without a traceable grounding observation".

A voice card is not an identity fact. It is a statistic over a corpus, not a claim about the world, and it cannot satisfy "no grounding, no row" in the ADR-0080 sense because there is no single grounding observation for "Yash writes 14-word sentences". `style_profiles.source_msg_ids` is the correct, weaker provenance form, and ADR-0013 already specifies it, together with the regeneration rule when a source message is deleted and the rule that profiles must not cite Alfred-generated drafts (to avoid a feedback loop where Alfred learns from its own output).

What the observation log **should** own is the audience bucket. `audience_bucket` is a relationship claim about a person (`manager`, `vendor`, `peer`), it is exactly the shape ADR-0080 governs, and ADR-0013 already says the assignment "comes from `user_facts`". The projection is live (`packages/assistant/src/knowledge/projection.ts`, `reader.ts`), and `resolveSenderKind` already reads profiles by email identity. So the bucket lookup has a supplier.


## 6. Weight-level options in 2026

### 6.1 Anthropic: no fine-tuning on the Claude API. Confirmed first-party.

The Claude platform glossary states it plainly ([Glossary](https://platform.claude.com/docs/en/about-claude/glossary), "Fine-tuning"):

> The Claude API does not currently offer fine-tuning, but ask your Anthropic contact if you are interested in exploring this option. Fine-tuning can be useful for adapting a language model to a specific domain, task, or writing style, but it requires careful consideration of the fine-tuning data and the potential impact on the model's performance and biases.

Note the vendor names "writing style" as a valid use, and then says the product does not exist.

**The one exception is old.** Fine-tuning for **Claude 3 Haiku** on Amazon Bedrock reached general availability on 2024-11-01, in the **US West (Oregon)** region only, text only, context up to 32K tokens ([AWS announcement](https://aws.amazon.com/about-aws/whats-new/2024/11/fine-tuning-anthropics-claude-3-haiku-amazon-bedrock), [AWS News blog](https://aws.amazon.com/blogs/aws/fine-tuning-for-anthropics-claude-3-haiku-model-in-amazon-bedrock-is-now-generally-available/)).

**This is a dead end for Alfred**, for four reasons that compound:
1. The model is Claude 3 Haiku, a 2024 model. It does not appear on the current Anthropic pricing table at all ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing)); even Claude Haiku 3.5 is listed as "retired, except on Bedrock and Google Cloud".
2. No Claude 4.x or 5 model has fine-tuning on any channel. **No primary evidence found** of any newer Claude fine-tuning product.
3. It requires an AWS Bedrock account in one region. Alfred runs on the first-party Claude API through Railway.
4. It sends the user's sent mail to a training job. See section 10 on privacy, and note that the LaMP authors themselves declined to send the private Avocado corpus to a third-party API.

### 6.2 OpenAI: preference tuning is shipped, and the vendor recommends it FOR STYLE

[OpenAI model optimization guide](https://developers.openai.com/api/docs/guides/model-optimization) lists these as shipped products:

| Method | Models | Status |
|---|---|---|
| Supervised fine-tuning | `gpt-4.1-2025-04-14`, `gpt-4.1-mini-2025-04-14`, `gpt-4.1-nano-2025-04-14` | GA |
| Vision fine-tuning | `gpt-4o-2024-08-06` | GA |
| **Direct preference optimization (DPO)** | `gpt-4.1-2025-04-14`, `gpt-4.1-mini-2025-04-14`, `gpt-4.1-nano-2025-04-14` | GA |
| Reinforcement fine-tuning | `o4-mini-2025-04-16` | GA, reasoning models only |

The DPO description is "Provide both a correct and incorrect example response for a prompt. Indicate the correct response to help the model perform better." The listed recommended use cases include, verbatim, **"Generating chat messages with the right tone and style"**.

Distillation is **not** listed as a shipped API product on that page.

So: **the vendor that ships preference tuning names tone and style as its lead use case, and it is not the vendor Alfred uses.** That is the cleanest statement of the trade-off. It is still vendor guidance with no number attached.

### 6.3 Google Vertex AI

[Vertex AI tuning documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/tune-models) lists three tuning families: **supervised fine-tuning**, **reinforcement learning fine-tuning**, and **preference tuning**. The per-model support matrix and the GA-versus-preview status per method were not extractable from the index page, so this file does not assert them. Alfred already has a Gemini fallback chain (`packages/ai/src/provider.ts:43`), so this is a live option in principle, but Gemini is a fallback and not the drafting model.

### 6.4 Style is learnable from very few examples

Zhou, Liu, Xu et al., "LIMA: Less Is More for Alignment" ([arXiv:2305.11206](https://arxiv.org/abs/2305.11206), NeurIPS 2023). A 65B LLaMa fine-tuned on only **1,000 curated prompt-response pairs**, with no RLHF. In human preference comparisons, LIMA responses were preferred or judged equal in **43%** of cases against GPT-4, **58%** against Bard, and **65%** against DaVinci-003. The paper's stated conclusion:

> almost all knowledge in large language models is learned during pretraining, and only limited instruction tuning data is necessary

This is the **Superficial Alignment Hypothesis**: the model already knows how to write; alignment only selects the format and style of the response.

**Read it correctly.** LIMA is about instruction-following style in general, not about a named individual's voice. It does not measure "how many of Yash's emails train a Yash adapter". But it is the best available evidence for the claim that **surface style is cheap to move and does not need a large corpus**. It is a 2023 result. Treat the specific win rates as stale; treat the direction as intact.

**No primary evidence found** for a published "N samples to learn one person's writing style" curve.

### 6.5 The open-weight route: a LoRA style rewriter, measured

"Small Is Enough: Per-User Style Rewriting of AI-Edited Text via LoRA Adapters" ([arXiv:2607.29238](https://arxiv.org/html/2607.29238)). This is the closest published system to the two-stage design the parent asked about.

- Base models: Qwen2.5 at 0.5B, 1.5B, 3B and 7B parameters.
- Adapter: **LoRA rank 8**.
- Training data: **1,242 paired examples** derived from **414** source paragraphs of the user's own prose. Pairs are made by having small helper models paraphrase the user's paragraph, so the target is the user's original and the input is the AI-flattened version.
- Training time: **9.53 minutes** at 0.5B, **67.73 minutes** at 7B.

Measured, on 219 evaluation pairs:

| Metric | Result |
|---|---|
| Composite score (0-1) | plateaus at **0.69 across all model sizes** |
| Authorship score | 0.51 to 0.53 |
| Content preservation (BERTScore) | 0.92 to 0.94 |
| AI-tell reduction | 0.45 to 0.55 |
| Perceived AI-ness (LLM judge, 0-10, 400 ratings) | rewritten **5.34** against input **6.85**, a **22%** reduction |

Two facts matter more than the headline. First, **the composite score plateaus at 0.5B**. Bigger did not help. A style rewriter is a small job. Second, the paper reports **no comparison against a prompting baseline**, so it does not establish that the LoRA beats a good few-shot prompt. That gap is the reason this axis stays below the line in section 10.

Also note that the perceived-AI-ness measurement is by an **LLM judge**, not by humans, despite the section being labeled human evaluation. See section 7.1 for why that matters.

### 6.6 Two-stage generate-then-rewrite, measured

"SAG: Style-Aligned Article Generation via Model Collaboration" ([arXiv:2410.03137](https://arxiv.org/html/2410.03137)). Stage 1: a **frozen** LLM writes style-neutral content, which preserves its instruction-following and world knowledge and avoids catastrophic forgetting. Stage 2: a small trained model receives the summary, the neutral text and a style reference, and injects style. The small model is trained with supervised fine-tuning followed by content-level DPO.

Measured on NoteBench (249 users, 732 articles). Against GPT-4: ROUGE-L **+0.78**, BLEU-4 **+0.55**, with factual hallucination 12.16% against GPT-4's 11.75% and faithful hallucination 30.60% against 32.10%. Against a vanilla SFT baseline: ROUGE-L **+2.86**, BLEU-4 **+1.92**, and a 29.1% reduction in hallucination rate. The Qwen-7B plus Qwen-LLM pairing reached ROUGE-L 23.81 and BLEU-4 13.09.

**Honest reading.** The gains over GPT-4 are under one ROUGE-L point. The architecture is validated; the margin is thin. And it doubles the serving stack: Alfred would have to host a Qwen model, which no part of the current infrastructure does.


## 7. Sampling-time methods

### 7.1 Best-of-N against an LLM judge

The mechanism: sample N drafts, score each with a judge, keep the best. It needs no weight change and it works on a frozen API model.

**The judge is the weak link, and the bias is measured.** Dubois, Galambosi, Liang and Hashimoto, "Length-Controlled AlpacaEval: A Simple Way to Debias Automatic Evaluators" ([arXiv:2404.04475](https://arxiv.org/abs/2404.04475)). AlpacaEval is an LLM-judge benchmark that is "known to favor models that generate longer outputs". The authors fit a regression that answers the counterfactual "What would the preference be if the model's and baseline's output had the same length?". Removing that one bias moves the **Spearman correlation with human judgments from 0.94 to 0.98**.

Read the number both ways. Length bias is real and large enough to matter at the top of a leaderboard. It is also **correctable with a simple regression**, which is good news for Alfred: a style judge can be length-controlled.

**The second bias is worse for this task.** Sharma et al. ([arXiv:2310.13548](https://arxiv.org/abs/2310.13548), section 2.4) show that preference models prefer responses that match the stated view. A judge asked "does this sound like Yash?" with Yash's exemplars in context is being asked to agree with the context. That is precisely the shape sycophancy takes. **No primary evidence found** that measures sycophancy specifically in a style-similarity judge, so this is a predicted failure mode, not a measured one.

**Verdict.** Best-of-N is available to Alfred today and needs no new infrastructure. Its cost is N times the output tokens plus one judge call. At Sonnet 4.6 output pricing of $15 / MTok, N=4 on a 400-token email is 1,600 output tokens, about **$0.024**, plus a judge call. Its latency is the worst part: N parallel calls cost the slowest of the N, and a serial judge call adds a full round trip on top. For a background draft this is fine. For an interactive compose it is not.

### 7.2 A discriminator is the better reward, and there is real evidence for it

The alternative to a judge is a **verifier**: a model or statistic that answers "was this written by the same author as this corpus?". This is a solved research task with its own benchmark family, the PAN shared tasks on authorship verification.

Two primary results say the signal is strong.

**First, inside the training loop.** In "Teach LLMs to Personalize" ([arXiv:2308.07968](https://arxiv.org/abs/2308.07968)), the `AuthorPred` variant adds a multitask objective in which the model must distinguish whether a document belongs to the author. On the Avocado email corpus it produced the best Rouge-1 of the whole table, **41.02** against `SynCtx`'s 40.38 and the retrieval-only 37.69. Author distinction carries information that content-matching does not.

**Second, at inference on frozen weights.** "LLM one-shot style transfer for Authorship Attribution and Verification" ([arXiv:2510.13302](https://arxiv.org/html/2510.13302v1)) defines **OSST**, a score computed only from log-probabilities of a frozen causal LM:

`OSST(t2|t1) = log P[t2 | N(t2); t1, N(t1)]`

where `N(.)` is a neutral-style rewrite of the text. In words: how much easier does the model find it to produce text 2 after it has seen one example of turning neutral text 1 into styled text 1. Measured, closed-set attribution: an **8B LLaMA reaches 74.67% accuracy on PAN19-en against the STAR baseline's 59.39%**, with consistent improvements on PAN11, PAN12, PAN18 and PAN19. On verification, the normalized variants beat LLM-prompting baselines such as PromptAV at comparable scale, and the method holds up on the topic-controlled PAN23-24 Reddit sets where the contrastive baseline STAR degrades.

**Two things this means for Alfred.**
1. A "did Yash write this?" score is a **better-founded reward than a judge**, because it has a benchmark, a baseline, and a topic control. A judge has none of those.
2. **OSST as published is not directly runnable on the Anthropic API**, because it needs token log-probabilities of a candidate text, and the Messages API does not return them. A local small model would be needed for the scorer, or a different formulation.

### 7.3 Activation steering and style vectors: not available

Steering by adding a direction to the residual stream requires access to the model's internal activations. The Anthropic Messages API exposes no such interface. **This axis is open-weights only and is not available to Alfred.** It is listed so it is not proposed again.

### 7.4 Decoding parameters: mostly REMOVED from the API, and the evidence was thin anyway

This contradicts the plan in a hard way. Temperature and top_p are being retired.

From the [Messages API reference](https://platform.claude.com/docs/en/api/messages/create), verbatim:

> **`temperature`** — Deprecated. Models released after Claude Opus 4.6 do not support setting temperature. A value of 1.0 of will be accepted for backwards compatibility, all other values will be rejected with a 400 error.

> **`top_p`** — Deprecated. Models released after Claude Opus 4.6 do not support setting top_p. A value >= 0.99 will be accepted for backwards compatibility, all other values will be rejected with a 400 error.

Alfred's own capability map already records this: `packages/ai/src/models.ts:50` has `temperature: false` for `claude-opus-4-8`, and `packages/ai/src/models.ts:61` has `temperature: true` for `claude-sonnet-4-6`. So **the Opus tier cannot change temperature at all**, and no current model can set top_p.

On the underlying question, the vendor's own description is qualitative ([Glossary](https://platform.claude.com/docs/en/about-claude/glossary)):

> Higher temperatures lead to more creative and diverse outputs, allowing for multiple variations in phrasing... Lower temperatures result in more conservative and deterministic outputs that stick to the most probable phrasing and answers.

That is a claim about diversity, not about perceived humanness. **No primary evidence found** that links a temperature setting to a human judgment of "this reads as human-written". Given the deprecation, this axis is closed. Do not spend on it.


## 8. Measurement

Alfred cannot improve what it cannot score. This section is the one that decides the build order.

### 8.1 THE KEY NEGATIVE RESULT: a banned-word list is NOT a proxy for perceived humanness

The parent asked whether anyone has measured this. Someone has, and the answer is bad for the current design.

Juzek and Ward ([arXiv:2412.11385](https://arxiv.org/html/2412.11385v1)) ran a pre-registered preference experiment on Prolific. Participants saw pairs of abstracts, one with focal AI words (`delve`, `showcase`, `underscore`, `comprehend`) and one without, and chose the one they preferred. After exclusions the analysis covered **1,822 ratings** (1,215 distractor, 607 critical).

Verbatim results:

> when all critical items are analyzed together, there is a slight preference for the no-focal-word abstracts. However, this overall difference between all critical items and distractor items is not significant.

> [for other focal-word items] participants exhibited a slight but non-significant preference for abstracts **with** focal words.

Only one sub-case reached significance: items where `delve` appeared in the **first sentence** (`p = 0.023`).

**Read this carefully, because it is the load-bearing negative result of the whole file.** Removing the classic AI vocabulary did **not** reliably change human preference. One word, in one position, moved the needle. The rest did not. The excess-word list of section 2.1 is a strong **detection** signal and a weak **perception** signal.

The current design in `packages/ai/src/voice/prompt.ts:15` and `packages/ai/src/voice/voice-detector.ts:225` rests on the assumption that the two are the same thing. **They are measurably not.** The denylist is not useless; a detector-facing metric has value. But it cannot be the target, and `detectAiTells` scoring zero does not mean the email sounds like Yash.

A second, independent result points the same way. Jakesch, Hancock and Naaman, "Human heuristics for AI-generated language are flawed" ([PNAS 2023](https://www.pnas.org/doi/10.1073/pnas.2208839120), [arXiv:2206.07271](https://arxiv.org/abs/2206.07271)). Across three main experiments with about 4,600 participants judging about 7,600 self-presentations, detection accuracy was **50 to 52%**, that is, chance. Monetary incentives and feedback did not raise it. The authors compute that if participants had relied only on the genuinely diagnostic cues (nonsensical and repetitive text) they could have reached **58.8%**, so humans do have partial knowledge and then dilute it with wrong cues.

Two implications. First, "would a human catch it?" is a very low bar; the model is already past it for short prose. Second, and more important for Alfred: **the target is not "undetectable as AI". The target is "recognizable as Yash".** Those are different objectives with different metrics, and the current module optimizes the first.

### 8.2 Style embeddings: the strongest deterministic scorer available

Baumler, Bao, Nghiem, Yang, Carpuat and Daumé III, "Can You Make It Sound Like You? Post-Editing LLM-Generated Text for Personal Style" ([arXiv:2604.24444](https://arxiv.org/pdf/2604.24444), 2026-04-27). A pre-registered, IRB-approved study with **n = 81**, on tasks where personal style matters (wedding vows, apology letters).

They benchmarked six public style-embedding models by authorship identification on their own control text, ranking against 80 references from other participants plus one from the true author (their Table 2):

| Model | MRR | R@1 | R@8 |
|---|---|---|---|
| LUAR-MUD (Rivera-Soto et al., 2021) | **0.5888** | **0.4506** | **0.8333** |
| LUAR-CRUD | 0.4966 | 0.3519 | 0.7778 |
| multilingual-style-representation (Kim et al., 2025) | 0.4364 | 0.2901 | 0.6975 |
| CISR (Wegmann et al., 2022) | 0.4058 | 0.2778 | 0.6481 |
| StyleDistance (Patel et al., 2025) | 0.3688 | 0.2469 | 0.6049 |
| SAURON (Koornstra, 2023) | 0.3457 | 0.2284 | 0.5000 |
| Random | 0.0615 | 0.0123 | 0.0988 |

**LUAR-MUD picks the true author first out of 81 candidates 45% of the time, and inside the top 8 83% of the time.** Against a random baseline of 1.2% and 9.9%. That is a strong, cheap, deterministic, offline signal, and it is an Apache-2.0 model.

Their measured effects using this scorer:

| Finding | Result |
|---|---|
| Post-editing raises similarity to the author's unassisted writing | p = 0.0002, g = 0.55 |
| Post-edited text is still stylistically closer to LLM text than to the author's own | reported as significant |
| Post-edited text is MORE homogeneous across people than unassisted human text | p = 0.0002, **g = 1.42** |
| Post-edited text is LESS homogeneous than fully LLM text | p = 0.0002, g = -0.69 |

The g = 1.42 result is the flattening effect. Even after a human edits it, machine-drafted prose converges across different people. Their own summary of the mechanism:

> human-like changes made during post-editing are meaningfully unique to individuals while the AI-like aspects that are not addressed during post-editing are meaningfully shared between participants.

### 8.3 The calibration gap, and why a human check is still needed

Same paper, the result that should stop any plan from trusting one number:

> we find that they have a significantly positive but weakly calibrated correlation (H3, **r = 0.244 ± 0.076, p < .0001**)

That is the correlation between the LUAR style-similarity score and the participant's own perception of "does this sound like me". Significant, positive, and **weak**. The authors state the consequence directly: post-edited text is "often perceived as representative of participants' personal style despite remaining detectable LLM stylistic traces."

**So the honest position is: a style embedding is the best automatic scorer available, and it explains only a small share of the human judgment.** Use it as a regression guard, not as the definition of success. Any claim of "Alfred now sounds like Yash" needs Yash to read the output.

### 8.4 Classical stylometry: Burrows's Delta

Burrows, J., "'Delta': a Measure of Stylistic Difference and a Guide to Likely Authorship", *Literary and Linguistic Computing* 17(3), 2002, pp. 267-287 ([Oxford Academic](https://academic.oup.com/dsh/article-abstract/17/3/267/929277)). Delta compares texts by the relative frequencies of the **most frequent words**, which are mostly function words, and scores the pattern of over-representation and under-representation. It was validated on verse by twenty-five English Restoration poets.

Delta is a 2002 method. It is **stale as a state-of-the-art authorship method** (section 8.2 shows neural style embeddings are far better) but it remains useful to Alfred for one reason the neural models do not offer: **it is fully deterministic, needs no model, and is explainable**. A function-word frequency vector for the user's sent mail, compared against a draft, is a pure function that runs in the evalite lane with no API call and no GPU. The repo rule is deterministic-scorer-first, and Delta is the deterministic option.

Delta needs a reasonable amount of text per sample. **No primary evidence found** for a minimum text length at which Delta is reliable on email-length documents; the original work is on poetry corpora, which are much longer.

### 8.5 Authorship verification as a metric

The PAN shared tasks are the standing benchmark family for authorship verification, and they are what section 7.2's OSST result is measured against. Recall the numbers: an 8B LLaMA with OSST reaches **74.67% accuracy on PAN19-en** against the STAR baseline's **59.39%** ([arXiv:2510.13302](https://arxiv.org/html/2510.13302v1)).

For Alfred this is the same tool as 8.2 pointed a different way. A verifier answers "same author, yes or no". An embedding answers "how close". The embedding is the more useful score for a regression test because it is continuous.

### 8.6 The held-out sent-mail evaluation: what Alfred should actually build

This is the first thing to build, and everything else waits on it.

**The design.** Take a real sent email from `documents`, identified by `isSentGmailMetadata` (`packages/assistant/src/triage/sent-mail.ts:22`). Hide the body. Reconstruct the context that Alfred would have had at draft time: the thread it replies to, the recipient, the subject. Ask Alfred to draft. Compare the draft against the real body that Yash wrote.

**The precedent is exact.** This is the LaMP-6, LongLaMP and Avocado-email protocol from sections 4 and 5, run on Alfred's own corpus instead of a public one.

**Which metric, ordered by fit with the repo's deterministic-scorer-first rule:**

| Scorer | Deterministic | Fit for evalite | What it catches | What it misses |
|---|---|---|---|---|
| Greeting / sign-off exact match against the user's inventory | Yes, pure function | Best | The most visible personal marker | Everything in the body |
| Length ratio against the real reply; sentence-length variance | Yes, pure function | Best | The uniformity tic of section 2.3 | Word choice |
| Function-word / Burrows's Delta distance | Yes, pure function | Good | Register, formality | Content |
| `detectAiTells` (already shipped, `voice-detector.ts:225`) | Yes | Already wired | Detector-facing slop | Perceived voice, per 8.1 |
| ROUGE-L / METEOR against the real reply | Yes | Good, and comparable to published numbers | Overall closeness | Rewards content agreement, not style |
| LUAR-MUD cosine against the user's corpus | Yes given a local model | Good, needs a model download | Authorial style, best available | Correlates only r = 0.244 with human perception |
| LLM judge | No | Weakest | Fluency, obvious failures | Biased by length (8.7) and by sycophancy |
| Yash reads 20 pairs blind | No | Not automatable | The actual target | Cost, and it does not scale |

**Recommendation.** Build the deterministic block first (greeting, sign-off, length ratio, sentence-length variance, ROUGE-L against the held-out reply). That block alone gives a number that moves, needs no new dependency, and matches the published protocol. Add LUAR-MUD next as the style scorer. Keep a small blind human set as the acceptance gate, because 8.3 proves the automatic score is only weakly calibrated to the thing that matters.

**One trap to avoid.** Perplexity of the real reply under the drafting prompt is **not** usable. The Anthropic Messages API does not return token log-probabilities, so it cannot be computed against the model Alfred actually ships.

**One repo note.** The existing eval `packages/assistant/evals/voice-ai-tells.eval.ts` is a **behavior guard on chat prose**, not a voice-similarity eval. It combines `detectAiTells` with an `llmJudgeScorer` on synthetic prompts. It has no ground truth written by Yash. It should stay as it is, and the new held-out eval should sit beside it, not replace it.

### 8.7 LLM judge failure modes, restated as build constraints

- **Length bias.** AlpacaEval "is known to favor models that generate longer outputs"; the regression fix moved Spearman correlation with human judgment from **0.94 to 0.98** ([arXiv:2404.04475](https://arxiv.org/abs/2404.04475)). Any judge Alfred writes must be length-controlled, and email length is exactly the axis the voice work is trying to change.
- **Sycophancy.** Preference data favors agreement ([arXiv:2310.13548](https://arxiv.org/abs/2310.13548)). A judge shown Yash's exemplars and asked "does this match?" is being invited to agree.
- **Judge-as-human proxy is weak here.** The one paper that measured an LLM-judge "perceived AI-ness" score against a real corpus reported it as an LLM judgment, not a human one ([arXiv:2607.29238](https://arxiv.org/html/2607.29238), 400 ratings). Do not read those as human numbers.

### 8.8 A cliche highlighter supplies diagnostic features, not a voice target

Simon Willison's [LLM cliche highlighter](https://github.com/simonw/tools/blob/aabd3c5b1258a20ea2d512269ea72a7f083b07a6/llm-cliche-highlighter.html) is a useful implementation reference. It contains 38 patterns and 192 embedded self-tests. Most patterns are phrase matchers, but four detect prose structure rather than vocabulary:

- consecutive sentences that share a four-word sequence;
- two or more questions in a row;
- three or more sentences that start with the same non-trivial word;
- repeated clause heads such as `no X, no Y`.

Those features cover a gap in Alfred's current detector. `detectAiTells` finds tokens and phrases. It does not measure repeated sentence frames or local rhythm. The highlighter also shows how to keep such detectors bounded: each finder returns offsets and counts, and each finder has positive and negative test cases.

It does **not** supply evidence that a match makes prose less human. There is no labeled human-preference set, authorship benchmark, or precision/recall result behind the 38 patterns. The tool turns every pattern on by default even though its own `colon-triple` description says that pattern is noisy in technical writing. Its collector also drops overlapping matches according to pattern order, so its total is a presentation count, not a stable style score. Section 8.1 still controls: a larger catalog of recognizable model habits is not a proxy for perceived humanness or for Yash's voice.

**What Alfred should take from it.** Do not copy the catalog into `DEFAULT_VOICE_PROMPT`, `detectAiTells`, or `sanitizeVoice`. Add the four structural features above to the held-out sent-mail eval as **rates**, then compare each draft with the real reply and with Yash's sent-mail distribution. A repeated opener is a defect only when the draft uses it more than Yash does in comparable mail. Report the raw counts and distances as diagnostic metadata first. Promote a feature into a scorer only after the blind human set shows that the direction is useful.

This changes the proposed deterministic block from "sentence-length variance" to a small rhythm vector:

```
sentence-length mean and variance
echoing-sentence rate and longest run
stacked-question rate and longest run
repeated-opener rate and longest run
repeated-clause-head rate and longest run
```

The vector describes a distribution. It does not create another universal denylist. That is the structural difference between measuring whether a draft sounds like its author and checking whether it contains one of 38 fashionable tics.

## 9. Comparison table

Costs are per outbound email draft on `claude-sonnet-4-6` ($3 / MTok input, $15 / MTok output, $0.30 / MTok cache read). "Lift" is the measured effect from the cited source; blank means no primary evidence found.

| Approach | Measured lift | Cost per draft | Latency added | Available to Alfred today | How it is scored |
|---|---|---|---|---|---|
| Negative rule list (`DEFAULT_VOICE_PROMPT` today) | Removing focal AI words did NOT significantly change human preference ([2412.11385](https://arxiv.org/html/2412.11385v1), 1,822 ratings) | ~327 tokens, cached, ~$0.0001 | 0 | Yes, shipped | `detectAiTells`, a detector-facing proxy |
| Deterministic dash/emoji sanitizer (`sanitizeVoice`) | none published; enforces a rule the prompt leaks | 0 | sub-millisecond | Yes, shipped | unit tests |
| Positive style description (vendor-recommended shape) | none published. Vendor says "Tell Claude what to do instead of what not to do" ([best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)) | same token budget, cached | 0 | Yes | held-out eval, section 8.6 |
| Role / character description | none published. "Even a single sentence makes a difference" (vendor) | ~50 tokens, cached | 0 | Yes | held-out eval |
| Discrete audience label in the prompt (`audience_bucket`) | Routing beat RAG on APM: W/L 1.79 vs 1.16, Delta +1.11 vs +0.26 ([2605.21063](https://arxiv.org/html/2605.21063v1)). But that RAG is over OTHER users | ~10 tokens | 0 | Table + enum exist, unwired | held-out eval, split by bucket |
| **Retrieved own sent mail, k=4, in the user turn** | **Email subject, zero-shot: ROUGE-1 0.362 to 0.482, +33% ([LaMP](https://arxiv.org/abs/2304.11406) Table 4). Email body, zero-shot: ROUGE-1 0.1773 to 0.3490, +96.8% ([LongLaMP](https://arxiv.org/abs/2407.11016) Table 2)** | ~1,000 tokens uncached = **$0.003** | one pgvector query, ~10 ms | **Yes. `chunks` is embedded, `search()` exists** | held-out eval + ROUGE-L vs the real reply |
| Recency instead of similarity | Avocado email: Bleu 19.57 vs 21.19 for BM25, vs 17.27 no-history ([2308.07968](https://arxiv.org/abs/2308.07968) Table 2) | same | one indexed query | Yes | same |
| STATIC style profile document (`profile_doc`) | **~zero over retrieval alone.** `SumCtxInd` 21.23 Bleu vs `RankDocBM25` 21.19 ([2308.07968](https://arxiv.org/abs/2308.07968)) | ~300 tokens | 0 at draft time | Table + CRUD exist, zero callers | held-out eval, split by bucket |
| Draft-conditioned style summary | Avocado email: `SumCtx` 23.17 Bleu vs 21.19 retrieval-only, +9.3% | one extra cheap model call | +1 model round trip | Yes, but adds a call | held-out eval |
| Best-of-N with an LLM judge | none for style. Judge length bias is real and correctable: Spearman 0.94→0.98 ([2404.04475](https://arxiv.org/abs/2404.04475)) | N=4: ~$0.024 output + judge call | slowest of N, plus a judge round trip | Yes | length-controlled judge; verify with 8.6 |
| Best-of-N with an authorship VERIFIER | OSST: 74.67% vs STAR 59.39% on PAN19-en ([2510.13302](https://arxiv.org/html/2510.13302v1)) | N x output + local scorer | needs a local model | No. Needs token log-probs, which the Messages API does not return | PAN-style accuracy |
| Temperature / top_p | none linking either to perceived humanness | 0 | 0 | **No.** Both deprecated after Opus 4.6; `models.ts:50` already has `temperature: false` for Opus 4.8 | n/a |
| Activation steering / style vectors | n/a | n/a | n/a | **No.** Open weights only | n/a |
| Fine-tune Claude | n/a | n/a | n/a | **No.** "The Claude API does not currently offer fine-tuning" ([Glossary](https://platform.claude.com/docs/en/about-claude/glossary)). Only Claude 3 Haiku on Bedrock us-west-2, GA 2024-11 | n/a |
| DPO on a hosted model | Vendor names "Generating chat messages with the right tone and style" as a use case ([OpenAI](https://developers.openai.com/api/docs/guides/model-optimization)) | training + serving | new provider | Only on OpenAI or Vertex, not Anthropic | held-out eval |
| LoRA style rewriter, two-stage | Perceived AI-ness 6.85→5.34, -22%; authorship 0.51-0.53; content BERTScore 0.92-0.94; plateaus at 0.5B ([2607.29238](https://arxiv.org/html/2607.29238)) | GPU hosting | +1 model call | No. Needs self-hosted weights | LUAR + judge |
| Two-stage SAG (frozen LLM + trained SLM) | ROUGE-L +0.78 over GPT-4 on NoteBench ([2410.03137](https://arxiv.org/html/2410.03137)) | GPU hosting | +1 model call | No | ROUGE-L / BLEU-4 |

## 10. The Alfred verdict for email

### 10.1 Cheap and near-certain now

**1. Give `gmail.send_draft` any voice enforcement at all.** Today `packages/assistant/src/tool-runtime/internal/tools/gmail.ts:288` passes `input.bodyText` straight to `sendMessage`. `sanitizeVoice` runs on chat (`packages/assistant/src/chat/chat-turn-closure.ts:530`) and on briefing email (`packages/assistant/src/briefings/agent/tools.ts:204`), but **not on the one surface that leaves the building under the user's name**. This is not a research question. It is a hole.

**2. Retrieve four of the user's own sent emails and put them in the USER turn.** This is the single highest-value change, and it is the one with real numbers behind it: **+33% ROUGE-1 zero-shot on email subjects** (LaMP Table 4) and **+96.8% ROUGE-1 on email bodies** (LongLaMP). `k=4` is what LongLaMP measured as best for email, and it matches Anthropic's own "3-5 examples for best results".

**The infrastructure already exists.** `packages/db/src/schema/documents.ts:131` `chunks` carries a 1024-dimension `embedding`. `packages/assistant/src/connections/ingestion/gmail-ingest.ts:48` already chunks and embeds ingested Gmail. `packages/corpus/src/search.ts:69` `search()` already runs the cosine query with a `source` filter. The only missing piece is a **sent-only filter**, and its predicate already exists as `gmailSentSql()` at `packages/assistant/src/triage/sent-mail.ts:83`.

**3. Turn the voice prompt from a denylist into a description.** Anthropic's own page says "Tell Claude what to do instead of what not to do" and shows the `NEVER use ellipses` pair as the anti-pattern. `DEFAULT_VOICE_PROMPT` is five prohibitions out of seven rules with no reason given for any of them. Rewrite it as a positive description with the reason attached, and keep the deterministic sanitizer as the backstop for the dash rule, because a prompt rule leaks over long output and a stream transformer does not.

### 10.2 Needs a substrate change, but LESS than expected

**The `style_profiles` table already exists and has zero production callers.** `packages/db/src/schema/memory.ts:187`, `packages/assistant/src/knowledge/style-profiles.ts`, `packages/assistant/src/knowledge/types.ts:25` and `:38`. ADR-0013 already specifies the key `(channel, audience_bucket, recipient_id)`, the precedence order, the provenance columns, the regeneration rule, and the rule against citing Alfred's own drafts. `getStyleProfile` at `style-profiles.ts:178` already implements the precedence.

So the substrate work is **activation, not design**. The module comment at `style-profiles.ts:17` names the trigger: "when something actually drafts on the user's behalf". `gmail.send_draft` is that thing.

**But do not ship `profile_doc` as a static voice card and expect a win.** Section 5.2 is measured and it says a context-independent summary of the user adds essentially nothing over retrieved exemplars (`SumCtxInd` 21.23 Bleu against `RankDocBM25` 21.19 on the Avocado email corpus). The `examples` column is the column with evidence behind it. Fill `examples` first. Treat `profile_doc` as a hypothesis to test, and test it split by `audience_bucket`, because the per-bucket split is the only way the row becomes context rather than a generic summary.

**Per-recipient register.** `recipientId` is already a column and already wins the precedence sort. Its lift is **unmeasured** (section 4.3): the only supporting source is a 16-participant lab study with a different baseline. Wire the column, but attribute the change with the eval before claiming it.

**The audience bucket is the observation log's job.** ADR-0013 says the bucket comes from `user_facts`, which under ADR-0080 is a projection over the ADR-0067 observation log. That is correct placement and it needs no new decision. A voice card is a corpus statistic and must NOT go on the observation log, because it cannot satisfy ADR-0080's "no grounding, no row" rule. `style_profiles.source_msg_ids` is the right, weaker provenance.

### 10.3 Worth the cost only once measured

- **Judge-guided best-of-N.** Available today, ~$0.024 for N=4 plus a judge call, but it multiplies latency and it inherits two documented judge biases (length, sycophancy). Do it only after the held-out eval can prove the winner is actually better.
- **A tuned rewrite model.** The two published systems are real but thin: `SAG` beats GPT-4 by under one ROUGE-L point, and `InMyStyle` reports no prompting baseline at all, so it has not been shown to beat a good few-shot prompt. Both need self-hosted GPU weights, which no part of Alfred's Railway stack provides. **Defer.**
- **Fine-tuning Claude.** Not available. Do not re-propose.

### 10.4 Build the eval FIRST

Nothing above is attributable without it. The eval is described in section 8.6. In short: mask a real sent email from `documents` (identified by `isSentGmailMetadata`, `packages/assistant/src/triage/sent-mail.ts:22`), rebuild the draft-time context, generate, and score against the body Yash actually wrote.

Start with the deterministic block, which is what the repo rule demands: greeting and sign-off match against the user's inventory, length ratio, the rhythm vector from section 8.8, and ROUGE-L against the held-out reply. Add LUAR-MUD cosine second; it identifies the true author first out of 81 candidates 45% of the time (section 8.2). Keep a small blind human set as the acceptance gate, because the automatic score correlates with human perception at only **r = 0.244** (section 8.3).

Do not use `detectAiTells` as the target. Section 8.1 shows the words it counts do not reliably move human preference. Keep it as a regression guard on a different axis.

### 10.5 Trade-offs against real repo invariants

**Prompt-cache stability.** `DEFAULT_VOICE_PROMPT` is deliberately static (`packages/ai/src/voice/prompt.ts:8`). The static property must be preserved, and the way to preserve it is placement. `decorateAnthropicPrompt` at `packages/ai/src/request-projection.ts:86` puts ONE breakpoint on the whole system message, so **any per-run text inside the system string invalidates the entire system cache block**, including the `grounding` slot that claims to protect it (`packages/ai/src/voice/instructions.ts:22`). Priced: a 4,000-token system prompt costs $0.0012 per request cached and $0.015 per request rewritten, about **12.5x**. Putting the exemplars in the first user message costs **$0.003** and leaves tools and system cached, because messages sit below system in Anthropic's invalidation hierarchy. **Also: do not add a fifth cache breakpoint.** Alfred is at the 4-breakpoint cap and `packages/assistant/src/chat/chat-turn.ts:597` exists to warn when a cache block gets silently dropped.

**Privacy.** Retrieved sent mail enters the prompt, which means the user's own sent email goes to Anthropic on every draft. Two mitigations, both cheap. First, retrieve only from mail the user sent, never from mail the user received; that keeps third-party bodies out. Second, honor ADR-0013's rule that profiles never cite Alfred-generated drafts, so Alfred does not learn its own voice back. Note the precedent: the LaMP authors did not send the private Avocado corpus to GPT-3.5 at all, which is why the LaMP-6 GPT-3.5 column is `-`. Fine-tuning is a much larger privacy step than retrieval, because the corpus leaves permanently instead of per-request; ADR-0013 already rejected it for that reason.

**Cost.** About $0.003 per draft for the exemplar block. Against Alfred's LLM spend this is not a line item.

**Latency.** One pgvector query on an already-indexed table, roughly 10 milliseconds, against a multi-second model call. Not material. Best-of-N is the only option here with a real latency cost.

### 10.6 The `composeAgentInstructions` seam: what it must ACCEPT

The main session ruled out adding a fifth `AGENT_OUTPUT_PURPOSES` entry, because that adds a positive vocabulary term and removes nothing. The evidence in this file agrees for a stronger reason: **a fifth purpose string still cannot express a person, an audience, or a channel.** It would move the same missing information one level down.

The type that must change is `VoicePolicy` at `packages/ai/src/voice/instructions.ts:11`:

```ts
export type VoicePolicy = "default" | "none";
```

`"default"` names a document. It carries no author, no audience, no channel. What the four call sites actually differ on is not which document to paste; it is **whose voice, to whom, in what medium**.

The literature says the composed prompt must be able to carry three things that this type cannot express:
1. a **positive description** of the target voice, because negative rules are the vendor's own anti-pattern and section 8.1 shows the denylist is a weak proxy;
2. a **discrete audience label**, because that is the mechanism APM measured and the key ADR-0013 already chose;
3. **exemplars**, which is the only element with a large measured lift, and which must be emitted into the **message** slot, not the system slot, for the cache reason in 10.5.

Point 3 is a structural consequence, and it is the sharpest one. `composeAgentInstructions` returns a **single string** (`instructions.ts:33`) that becomes the system prompt. **Exemplars cannot go through it without breaking the cache.** So the seam must stop being "a function that returns a system string" and start being "a function that returns the system string plus the per-run message blocks". That is a real removal: the current design's implicit claim that all voice control fits in the system prompt is the thing that gets deleted.

**Files that change, and what each becomes:**

| File | Today | Becomes |
|---|---|---|
| `packages/ai/src/voice/instructions.ts:11` | `type VoicePolicy = "default" \| "none"` | a voice target that names author, audience and channel, or `"none"` |
| `packages/ai/src/voice/instructions.ts:27` | returns one system string | returns the system string AND the per-run message blocks, so exemplars land below the cache boundary |
| `packages/ai/src/voice/prompt.ts:15` | 27 lines, 5 of 7 rules negative, no reasons | a positive description with reasons attached; stays static and cacheable |
| `packages/ai/src/voice/voice-detector.ts:225` | the eval target | a regression guard only; NOT the target, per section 8.1 |
| `packages/ai/src/voice/voice-sanitize.ts` | deterministic dash backstop | unchanged, and now also applied to outbound mail |
| `packages/assistant/src/knowledge/style-profiles.ts` | CRUD with zero callers | the read path for a draft, `getStyleProfile(userId, "gmail", bucket, recipientId)` |
| `packages/corpus/src/search.ts:69` | `search()` with a `source` filter | plus a sent-only filter, using the existing `gmailSentSql()` |
| `packages/assistant/src/tool-runtime/internal/tools/gmail.ts:288` | raw `input.bodyText` to `sendMessage` | drafts composed through the voice seam; sanitizer applied |
| `packages/assistant/evals/` | no voice-similarity eval | a new held-out sent-mail eval, deterministic scorers first |


## 11. Sources

**Primary papers (read directly, numbers verified against the paper text or PDF):**

- Kobak, Marquez, Horvat, Lause. *Delving into LLM-assisted writing in biomedical publications through excess vocabulary.* [arXiv:2406.07016](https://arxiv.org/abs/2406.07016), *Science Advances* 11(27), 2025. 454 excess words in 2024, 66% verbs, `delves` r=28.0, >=13.5% of 2024 abstracts.
- Juzek, Ward. *Why Does ChatGPT "Delve" So Much?* [arXiv:2412.11385](https://arxiv.org/html/2412.11385v1). 21 focal words; RLHF not proven; **human preference experiment, 1,822 ratings, no significant overall effect**.
- Munoz-Ortiz, Gomez-Rodriguez, Vilares. *Contrasting Linguistic Patterns in Human and LLM-Generated News Text.* [arXiv:2308.09067](https://arxiv.org/abs/2308.09067). Sentence-length dispersion, vocabulary variety, dependency distance.
- Sharma et al. *Towards Understanding Sycophancy in Language Models.* [arXiv:2310.13548](https://arxiv.org/abs/2310.13548), ICLR 2024.
- Salemi, Mysore, Bendersky, Zamani. *LaMP: When Large Language Models Meet Personalization.* [arXiv:2304.11406](https://arxiv.org/abs/2304.11406). LaMP-6U Table 2 and zero-shot Table 4, verified from the PDF.
- Kumar, Salemi, Mysore et al. *LongLaMP: A Benchmark for Personalized Long-form Text Generation.* [arXiv:2407.11016](https://arxiv.org/abs/2407.11016). Personalized Email Completion, Contriever k=4.
- Li, Zhang, Luo, Chang et al. *Teach LLMs to Personalize — An Approach inspired by Writing Education.* [arXiv:2308.07968](https://arxiv.org/abs/2308.07968). Table 2 (Avocado email) verified from the PDF: `SumCtxInd` vs `SumCtx` vs `AuthorPred`.
- Baumler, Bao, Nghiem, Yang, Carpuat, Daumé III. *Can You Make It Sound Like You? Post-Editing LLM-Generated Text for Personal Style.* [arXiv:2604.24444](https://arxiv.org/pdf/2604.24444). n=81, LUAR-MUD Table 2, `r = 0.244` calibration gap, `g = 1.42` homogenization.
- Jakesch, Hancock, Naaman. *Human heuristics for AI-generated language are flawed.* [PNAS 2023](https://www.pnas.org/doi/10.1073/pnas.2208839120) / [arXiv:2206.07271](https://arxiv.org/abs/2206.07271). ~4,600 participants, 50-52% detection accuracy.
- Dubois, Galambosi, Liang, Hashimoto. *Length-Controlled AlpacaEval.* [arXiv:2404.04475](https://arxiv.org/abs/2404.04475). Spearman 0.94 -> 0.98.
- *LLM one-shot style transfer for Authorship Attribution and Verification.* [arXiv:2510.13302](https://arxiv.org/html/2510.13302v1). OSST, PAN19-en 74.67% vs STAR 59.39%.
- Zhou, Liu, Xu et al. *LIMA: Less Is More for Alignment.* [arXiv:2305.11206](https://arxiv.org/abs/2305.11206), NeurIPS 2023. 1,000 examples; 43/58/65% preference. **2023, treat the win rates as stale.**
- *Small Is Enough: Per-User Style Rewriting of AI-Edited Text via LoRA Adapters.* [arXiv:2607.29238](https://arxiv.org/html/2607.29238). LoRA rank 8, plateaus at 0.5B, -22% perceived AI-ness by LLM judge, **no prompting baseline**.
- *SAG: Style-Aligned Article Generation via Model Collaboration.* [arXiv:2410.03137](https://arxiv.org/html/2410.03137). NoteBench, ROUGE-L +0.78 over GPT-4.
- *APM: Evaluating Style Personalization in LLMs with Arbitrary Preference Mappings.* [arXiv:2605.21063](https://arxiv.org/html/2605.21063v1). Routing W/L 1.79 vs RAG-Summary 1.16. **RAG here is over OTHER users; not comparable to LaMP.**
- *PersonaMail: Learning and Adapting Personal Communication Preferences for Context-Aware Email Writing.* [arXiv:2602.17340](https://arxiv.org/html/2602.17340). n=16 lab study, per-recipient anchors.
- Burrows, J. *"Delta": a Measure of Stylistic Difference and a Guide to Likely Authorship.* *Literary and Linguistic Computing* 17(3), 2002, 267-287. [Oxford Academic](https://academic.oup.com/dsh/article-abstract/17/3/267/929277). **2002, stale as state of the art; still the deterministic option.**

**Vendor documentation (first-party guidance, not measurement):**

- Anthropic. [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). "Tell Claude what to do instead of what not to do"; "Include 3–5 examples for best results"; "Migrating away from prefilled responses".
- Anthropic. [Increase output consistency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/increase-consistency). "Provide examples of your desired output. This is more effective than abstract instructions."; "Keep Claude in character".
- Anthropic. [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). 4 breakpoints, 1,024-token minimum for Sonnet 4.6 and Opus 4.8, hierarchical invalidation.
- Anthropic. [Pricing](https://platform.claude.com/docs/en/about-claude/pricing). Sonnet 4.6 $3/$15 per MTok, cache read 0.1x, 5m write 1.25x.
- Anthropic. [Messages API reference](https://platform.claude.com/docs/en/api/messages/create). `temperature` and `top_p` deprecated after Claude Opus 4.6.
- Anthropic. [Glossary](https://platform.claude.com/docs/en/about-claude/glossary). "The Claude API does not currently offer fine-tuning".
- AWS. [Fine-tuning for Claude 3 Haiku is now GA](https://aws.amazon.com/about-aws/whats-new/2024/11/fine-tuning-anthropics-claude-3-haiku-amazon-bedrock), 2024-11-01, US West (Oregon) only.
- OpenAI. [Model optimization guide](https://developers.openai.com/api/docs/guides/model-optimization). SFT / DPO / RFT; DPO recommended for "Generating chat messages with the right tone and style".
- OpenAI. [Text generation guide](https://developers.openai.com/api/docs/guides/text). One style example (`Talk like a pirate`); no measurement.
- OpenAI. [Model Spec (2026/08/18)](https://model-spec.openai.com/2026-08-18.html). Style and tone are guideline-level and implicitly overridable.
- Google. [Vertex AI tuning](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/tune-models). SFT, RL fine-tuning, preference tuning listed; per-model matrix not extractable.
- GPTZero. [Perplexity and burstiness](https://gptzero.me/news/perplexity-and-burstiness-what-is-it/). **Vendor explainer. No accuracy numbers, no benchmark.**

**External implementation reference (not measurement):**

- Simon Willison. [LLM cliche highlighter](https://github.com/simonw/tools/blob/aabd3c5b1258a20ea2d512269ea72a7f083b07a6/llm-cliche-highlighter.html), commit `aabd3c5` (2026-08-27). 38 phrase and structural patterns, 192 embedded self-tests; no labeled human-preference or authorship benchmark.

**Repo (`path:line`):**

- `packages/ai/src/voice/prompt.ts:8,15` · `packages/ai/src/voice/instructions.ts:11,22,27,33` · `packages/ai/src/voice/voice-detector.ts:225` · `packages/ai/src/voice/voice-sanitize.ts`
- `packages/ai/src/models.ts:46,50,57,61` · `packages/ai/src/provider.ts:43,71` · `packages/ai/src/request-projection.ts:65,86`
- `packages/assistant/src/chat/chat-turn.ts:210,597` · `packages/assistant/src/chat/chat-turn-closure.ts:530` · `packages/assistant/src/briefings/agent/tools.ts:204`
- `packages/assistant/src/tool-runtime/internal/tools/gmail.ts:288`
- `packages/assistant/src/triage/sent-mail.ts:22,83`
- `packages/assistant/src/knowledge/style-profiles.ts:17,107,178,203` · `packages/assistant/src/knowledge/types.ts:25,38`
- `packages/db/src/schema/memory.ts:187` · `packages/db/src/schema/documents.ts:26,131`
- `packages/corpus/src/search.ts:69` · `packages/assistant/src/connections/ingestion/gmail-ingest.ts:48`
- `packages/assistant/evals/voice-ai-tells.eval.ts`
- `docs/decisions/ADR-0013-style-profiles-dedicated-table-channel-audience.md` · `docs/decisions/ADR-0067-...` · `docs/decisions/ADR-0080-...`

**Gaps: where no primary evidence was found.**

- No measured comparison of a positive style description against a negative banned-phrase list, from any vendor or paper.
- No measured comparison of per-recipient retrieval against user-level retrieval.
- No isolated measurement of greeting, sign-off, or length-distribution imitation.
- No published "N samples to learn one person's writing style" curve.
- No measurement of sycophancy inside a style-similarity judge.
- No link between a temperature setting and a human judgment of humanness.
- No minimum text length at which Burrows's Delta is reliable on email-length documents.
