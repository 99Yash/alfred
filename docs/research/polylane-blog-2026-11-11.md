# Polylane blog: what applies to Alfred's agent foundations

Status: Research, 2026-11-11. No runtime change. Repo facts are verified at `9b726f535`. The decisions are in [ADR-0124](../decisions/ADR-0124-code-mode-is-the-chat-read-path.md) and [memory.md](../theory/memory.md).

Polylane builds proactive agents for operations. This note keeps only the ideas that change an Alfred decision. All quotes were checked against the page text on 2026-11-11. All numbers are Polylane's own, on its own setup, with no published evals. They show a direction, not a size.

## Sources

| Post | Date | URL |
| --- | --- | --- |
| What even is code mode? | 2026-11-05 | https://polylane.com/blog/what-even-is-code-mode/ |
| How to build a memory system for proactive agents | 2026-10-22 | https://polylane.com/blog/how-to-build-a-memory-system-for-proactive-agents/ |
| Turn your app into a context graph | 2026-10-05 | https://polylane.com/blog/turn-your-app-into-a-context-graph/ |
| How we prevent slop from hitting prod | 2026-09-21 | https://polylane.com/blog/how-we-prevent-slop-from-hitting-prod/ |
| Sub-agents are just wrong | 2026-09-14 | https://polylane.com/blog/sub-agents-are-just-wrong/ |
| I'm Betting My Company on Proactive Agents | 2026-07-05 | https://polylane.com/blog/proactive-agents/ |

## 1. Memory

Polylane keeps memory as markdown in git. A nightly check reads each claim against the real sources. It confirms the settled theory in three places:

- Code, not the agent, selects the work set: changed first, then never checked, then the oldest check. "Which files get checked is decided in code, not by the agent."
- The agent has no write path. Code commits after the turn.
- Polylane left embeddings because "A wrong fact was hard to find and harder to fix, there was no history of who wrote what". This is the same reason as ADR-0123.

**Adopted in memory.md:**

- **A cap on changes in each run:** `max(3, 15%)`. "An agent that decides half the memory is wrong is more likely to be wrong itself."
- **A person's edit to an agent output is evidence.** "When someone merges a pull request Polylane opened, what they changed before merging says more than any review comment." A PR that the system closes gives no lesson, which is principle 5.

**Not adopted:** the git and markdown store (rows join to the context graph). The post contradicts itself on claims that cannot be checked, so it gives no answer to Q6.

## 2. Context graph

Their catalog maps "the checkout database" to a resource id. "An agent rarely knows a node's ID." This confirms name links. Each edge keeps its evidence and `discovered_via`, which `entity_edges.provenance` already holds.

**Not adopted:** the linker with patterns for each vendor (principle 4), and the operations data (baselines, key queries, blast radius).

## 3. Code mode

"Code mode has nothing to do with MCP, it's a decision about where tool results go: either into the model's context, or into the variables of a program the model wrote."

- Each script runs in a new isolate with no network. Each tool is a stub that calls the trusted host, which holds the credentials. This is the ADR-0087 model.
- The tool description holds a typed index. A describe call returns the full types. "The output type matters as much as the input type."
- "So executeCode refuses state-changing calls when a person is in the conversation, and the model makes them one at a time as normal tool calls."
- The prompt asks for a `try/catch` around each call and `Promise.all` for independent calls.
- Numbers (30 days): more than 70% of tool calls ran in code, tool output in the context was about 14x smaller, and 98.8% of scripts succeeded.

**Adopted in ADR-0124:** code mode as the chat read path, MCP reads included, output types in the index, and direct writes.

## 4. The production check on PRs

The check follows the context graph from a PR to the resources that it touches, and it writes failure trajectories with a citation on each link. "We take a conservative approach and any confirmed trajectory leads to a failed assessment."

**Not adopted:** a migration or deploy gate. Alfred's tables are small, Drizzle runs each migration in a transaction, and `serverEnv()` already fails at boot on a missing env var. The pattern "the model cites, code derives the verdict" is already principle 4.

## 5. Agent shape and autonomy

Inputs for the loop-theory session (theory start page, item 2):

- "The line isn't human versus agent. It's reversible versus not." The agent acts alone only to go back to a known-good state.
- The default verdict is "no anomaly". "Noticing without acting is just a smarter alert, and alerts are the thing I'm trying to kill."
- "The agent that gathers the evidence should be the agent that acts on it." "Per-agent evaluations pass while the system fails, because the failures live between the agents."
