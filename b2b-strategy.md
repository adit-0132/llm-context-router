# Context Porter — B2B Strategy

Companion to [db.md](db.md) (storage primitives). This doc covers the business case
for server-side storage and the **Organizational Intelligence Layer** idea built on top
of the stored corpus.

Claims are tagged `[Certain]`, `[Likely]`, or `[Guessing]`.

--

## 1. Framing Correction: Storage Is Not the Value

"We need server-side storage to generate value" has the causation backwards.
Nobody pays for bytes at rest. Storage is a cost center and a liability. [Certain]

The real question: what becomes possible only with a server, and is that worth the
liability it creates? Build storage first and look for value second, and you've built a
breach surface with a subscription bolted on.

---

## 2. The Threat-Model Flip (Why the db.md Verdict Changes for B2B)

[db.md](db.md) concluded server storage was the wrong model. That was a *consumer*
judgment. For B2B it flips: [Likely]

- **Individuals** want conversations private *from us*.
- **Enterprises** often want conversations centralized, logged, and governed — that is a
  compliance requirement, not a violation. Companies already paste proprietary code into
  Claude/GPT; the data already left the building. Centralizing the exports under IT
  control is better governance than 50 engineers with `.llmchat` files in Downloads.

That flip is the opening. It comes with a hard consequence (Section 5).

---

## 3. Where the B2B Value Actually Is

None of these are "storage." Storage is the enabler. [Likely throughout]

1. **Shared team knowledge base.** Engineer A debugs a hard problem with Claude; that
   context becomes a searchable org asset instead of dying in one person's downloads.
   Strongest single value driver — institutional memory of LLM work.
2. **Cross-platform unification.** The moat. Enterprises use Claude *and* GPT *and*
   Gemini. No LLM vendor will unify across competitors. We can. A single governed library
   regardless of source platform is something the vendors structurally won't build.
3. **Governance & audit.** Who exported what, when; retention policies; DLP hooks.
   SOC2/ISO clients need this — it's a checkbox that closes deals.
4. **Admin control / RBAC / SSO.** The enterprise-tier wrapper. Per-seat billing lives here.
5. **Semantic search over the corpus.** The compression engine already does
   TF-IDF/segmentation — same machinery powers org-wide search.
6. **Analytics.** Which models the org leans on, token spend, recurring topics.

---

## 4. Competitive Risk

Anthropic Projects and OpenAI team features already do *single-vendor* knowledge sharing.
Defensibility is **only** the cross-platform angle (#2 above). If cross-platform is not
central to the pitch, we're racing the LLM vendors on their home turf and will lose. [Likely]

---

## 5. The Hard Consequence

The moment we store customer conversations server-side, we become a data processor holding
possibly the most sensitive content a company produces — secrets, proprietary code,
unreleased strategy. [Certain]

Table stakes before the first enterprise sale: encryption at rest + in transit, tenant
isolation, SOC2 Type II (6–12 months of runtime), a DPA, GDPR/data-residency handling,
SSO/SAML. [Likely] One breach is company-ending because of *what* we'd store. This is the
cost side of the flip — not optional, and expensive.

---

## 6. De-Risking Architectures

We don't have to choose "fully local" vs. "we hold everything."

| Model | We store | Liability | Kills which features |
|---|---|---|---|
| **E2EE / zero-knowledge** | ciphertext only | Lowest — we can't read a breach | Server-side search, compression, analytics |
| **BYO-cloud / self-hosted** | nothing; runs in their VPC | Low — data never leaves customer | Our ops simplicity; harder to support |
| **Multi-tenant SaaS** | plaintext (encrypted at rest) | Highest — full compliance burden | Nothing, but we own all the risk |

For security-sensitive enterprises, **BYO-cloud / on-prem is the smart wedge** [Likely]:
it neutralizes the privacy objection that kills these deals ("your data never touches our
servers"). We sell the *management layer*, not the storage. Downside: harder support and
deployment.

---

## 7. The Organizational Intelligence Layer

This is the answer to "why store at all." It turns the corpus from a passive archive into
an active asset: AI agents mine the org's accumulated prompts, code, and stack to generate
shared artifacts.

**Candidate artifacts:**
- Org-level `CLAUDE.md` (shared standards + context for AI coding)
- `SKILL.md` templates / reusable skill scaffolds
- A curated prompt-template library (the org's most effective prompts)
- New-hire onboarding pack ("how this team works with AI, our stack")
- Tech-stack / dependency map mined from code in conversations
- Model-routing recommendations ("you use Opus for trivial tasks — route to Haiku, save $X")
- Knowledge-gap report (recurring questions = missing docs/training)
- Duplicate-effort detection (two teams solving the same problem)

### 7.1 Weakest Parts (Read First)

**Descriptive vs. prescriptive.** A `CLAUDE.md` is meant to be prescriptive — how we *want*
to work. Mining conversations gives descriptive data — how we *do* work. Auto-generating
from chat logs risks codifying the org's bad habits as the standard and producing a bland,
averaged-out document. Garbage in, averaged garbage out. This is a conceptual flaw, not a
tuning problem. [Likely] Mitigation: treat generated artifacts as *drafts for human review*,
never auto-published.

**No quality signal for prompts.** "Best prompts" assumes ground truth for prompt quality
we don't have. Without a feedback signal (did the user accept the output? stop re-asking?),
"prompt insights" will be plausible-sounding but unvalidated. [Likely] A usable proxy:
conversation length-to-resolution, repeated rephrasings (a bad sign), explicit thumbs.

**Secret leakage / cross-contamination.** If an engineer pasted an API key or proprietary
algorithm into a prompt, an agent mining the corpus could leak it into an org-wide
`CLAUDE.md` or a shared skill template. [Certain] Mandatory: secret-scanning and PII
redaction before any aggregation step.

**Consent / surveillance.** Aggregating individuals' prompts into "org insights" means
profiling how people work. Even if the company owns the data, this can trigger
works-council/employee-trust issues, especially in the EU. [Likely]

### 7.2 Variant 1 — Visible (We Process Plaintext Server-Side)

We run the agents server-side with read access to content.

- **Pros:** richest analysis; cross-user aggregation is trivial; use the largest models;
  semantic clustering across the whole corpus; continuous pipeline improvement.
- **Cons:** maximum liability (Section 5); the consent problem; secret-leakage surface;
  a single breach is catastrophic. Learning from customer A to help customer B is itself a
  privacy minefield and likely contractually prohibited. [Likely]
- **Business model:** SaaS, per-seat + usage. We own the pipeline IP.

### 7.3 Variant 2 — Blind (E2EE / Agent Runs Where Data Is Decryptable)

We ship the pipeline — prompts, orchestration, model-routing config, output schemas — but
never receive content. The agent runs client-side or in the customer's VPC, against an LLM
endpoint the customer controls (their key, or a proxy we broker).

- **Pros:** privacy moat ("we generate your org intelligence without ever seeing your
  data"); lower compliance scope; largely sidesteps the consent problem (data stays in
  customer control); aligns with the extension's existing client-side architecture.
- **Cons:** we're blind, so we can't improve the pipeline from real data; QA is harder
  (we can't see outputs); debugging is harder; cross-org learning is weak; compute happens
  on the customer side. Versioning a pipeline we can't observe is an ops challenge. [Likely]
- **Business model:** license the pipeline / agent framework + the curated prompt library.
  "Bring your own LLM key." We sell orchestration and artifact schemas, not processing.

### 7.4 Comparison

| Dimension | Variant 1 (Visible) | Variant 2 (Blind) |
|---|---|---|
| Our data liability | Maximum | Near-zero |
| Analysis richness | Highest | Constrained |
| Pipeline self-improvement | Easy | Hard (we're blind) |
| Enterprise trust pitch | Weak | Strong |
| Compliance burden | Full (SOC2, DPA, residency) | Light |
| Defensible IP | Pipeline + aggregate data | Pipeline + artifact schemas |
| Fits existing architecture | No (new server) | Yes (client-side) |

### 7.5 Hybrids Worth Considering

- **Federated metadata.** In Variant 2, the blind agent returns only aggregate, non-
  sensitive metadata (e.g., "org uses Python + React, prefers terse prompts") under
  differential privacy. Lets us improve the pipeline without seeing raw content. Bridges
  the blind/visible gap; adds complexity. [Likely useful]
- **Confidential computing (TEE).** We process in an enclave we can't inspect — Variant-1
  richness with Variant-2-ish trust. Complex and expensive; probably premature at this
  stage. [Guessing on practicality]

---

## 8. Data Products Ranked (by ROI vs. Sensitivity)

| Product | ROI clarity | Data sensitivity needed | Notes |
|---|---|---|---|
| Model-routing / cost optimization | High (measurable $) | Low (metadata only) | Best blind-friendly starter; hard dollar ROI |
| Knowledge base + search | High | High (content) | Core value, but needs full content access |
| Org `CLAUDE.md` / `SKILL.md` draft | Medium | High (content) | Human-review gated; descriptive-vs-prescriptive risk |
| Onboarding pack | Medium | Medium | Derived from the above |
| Prompt-template library | Low–Medium | High | Blocked by the missing quality signal |
| Duplicate-effort detection | Medium | High | Strong "aha" demo if it works |

The **model-routing / cost optimizer** is the cleanest first product: measurable ROI,
needs only metadata, and fits the blind model. It earns trust before asking for content
access. [Likely]

---

## 9. Recommendation

1. Lead the product with the **knowledge base + cross-platform** value, not "cloud storage."
2. Default to **Variant 2 (blind)** as the strategic posture — it dodges the liability that
   makes Variant 1 dangerous, "we never see your data" is a killer enterprise pitch, and it
   matches the extension's client-side design. Accept that pipeline QA gets harder. [Likely]
3. Ship the **cost/model-routing optimizer** first (metadata-only, hard ROI), then expand to
   content-dependent artifacts once trust and willingness-to-pay are validated.
4. Gate every generated artifact (`CLAUDE.md`, `SKILL.md`, prompt library) behind **human
   review**. Never auto-publish mined output.
5. Validate willingness-to-pay **before** building the SOC2/DPA/SSO machinery — that's a
   6–12 month tax not worth paying on an unvalidated hypothesis. [Likely]

---

## 10. Open Questions (Decide Before Designing)

- **Who is the buyer?** A 10-person startup team vs. a regulated enterprise pushes to
  opposite ends of the architecture table.
- **Is cross-platform unification the core pitch or a side feature?** Determines whether we
  have a moat against the LLM vendors.
- **Visible or blind as the default posture?** Determines the entire compliance and
  engineering roadmap.
- **What is the quality signal for "good prompt"?** Without one, prompt-insight products
  are unfounded.
