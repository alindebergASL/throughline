# Throughline UX and Interaction Specification v0.1

**Status:** Pre-build UX baseline  
**Product:** Throughline  
**Category:** AI-native Work Operating System  
**Distinctive architecture:** Active, trusted organizational memory  
**Operating engine:** Governed agentic runtime  
**First solution:** Account & Partner Operations  
**First domain profile:** AI Solutions  
**First indispensable loop:** Engagement -> Memory -> Action  
**Date:** June 26, 2026

---

## 0. Executive decision

Do not implement the UI from the current visual mockups.

Those mockups were directionally useful, but they drifted toward a busy enterprise dashboard: too many nav items, too many cards, too many metrics, and too much always-visible assistant surface. Throughline should feel calmer, more focused, and more trusted.

The UX direction is now:

> **Calm by default. Precise when needed. Evidenced when challenged. Agentic when useful.**

The product should not show everything it knows. It should show what needs attention, what changed, what is trusted, and what the next move is. Everything else should be available through progressive disclosure, search, command actions, and source-backed evidence panels.

The Phase 0/1 build spec already establishes the spine: Throughline turns engagement capture into proposed claims, governed ChangeSets, approved facts, cited summaries, Today, and Pulse. This UX spec turns that architecture into an interaction model.

---

## 1. Research basis

This specification uses the existing Throughline build spec and current UX/accessibility research.

### 1.1 Internal product basis

The build spec locks these UX-relevant principles:

- Throughline is identified by active, trusted organizational memory, not just by the broad Work OS category.
- The first loop is Engagement -> Memory -> Action.
- SourceArtifact -> Claim -> AcceptedFact -> DerivedView is the persisted truth pipeline.
- The agent proposes ChangeSets instead of directly changing shared truth or the outside world.
- Untrusted ingestion and trusted action are separate planes.
- Impact triage is deterministic; the model cannot decide a consequential change is routine.
- Multi-approver items escalate without blocking the reviewer’s batch.
- Manual notes and voice capture must be sufficient when no meeting transcript exists.
- The v1 UI shell is Today, Organizations, and Pulse with universal command/search always available.
- The highest-priority UX surface is Engagement Review.
- The agent surface is command/search and contextual actions, not a permanent chat wall.

### 1.2 External UX research basis

The direction is grounded in these current design principles:

1. **Progressive disclosure reduces complexity.** Nielsen Norman Group defines progressive disclosure as deferring advanced or rarely used features to secondary screens so users can focus on primary options first. This directly supports a calmer Throughline default state.
2. **Minimalist design improves signal-to-noise.** Nielsen Norman Group’s usability heuristics emphasize aesthetic and minimalist design: remove irrelevant information so users can focus on what supports their task.
3. **System status and user control remain core.** Nielsen’s heuristics also reinforce visibility of system status, user control/freedom, recognition over recall, error prevention, and help users recover from errors. These map directly to AgentRun status, ChangeSet review, undo/compensation, and clear evidence affordances.
4. **Human-AI interfaces need expectation-setting, correction, and graceful failure.** Microsoft’s Guidelines for Human-AI Interaction emphasize how AI systems should behave initially, during normal use, when wrong, and over time.
5. **Human-centered AI requires feedback, control, explanations, and graceful failure.** Google’s People + AI Guidebook frames AI product design around human-centered guidance, feedback/control, explanations, and error handling.
6. **Citations alone can cause overtrust.** NN/g’s 2025 work on explainable AI notes users may trust cited AI answers without clicking or verifying sources. Throughline therefore cannot rely on citation badges alone; the UX must make evidence easy to inspect and make uncertainty legible.
7. **Do not over-humanize the agent.** NN/g’s 2025 AI trust research argues users trust AI more when it appears competent rather than sentient. Throughline should feel intelligent and accountable, not anthropomorphic.
8. **Accessibility is a product requirement.** WCAG 2.2 is the current W3C recommendation for accessible web content, and WAI-ARIA APG provides common widget patterns and keyboard interaction guidance. Throughline’s review-heavy workflow must be keyboard-first and screen-reader coherent from the start.

References are listed in Appendix C.

---

## 2. Product feel

Throughline should feel like a trusted work surface, not a cockpit.

It should be:

- calm, not dense;
- focused, not dashboard-heavy;
- trustworthy, not magical;
- evidence-backed, not citation theater;
- proactive, not noisy;
- agentic, not chat-first;
- precise, not bureaucratic;
- useful without integrations;
- faster than the manual workflow it replaces.

### 2.1 The emotional target

A user should feel:

> “Throughline knows what matters, shows me less, keeps me honest, and helps me finish the work.”

A user should not feel:

> “This is another CRM dashboard I have to feed.”

or:

> “This AI assistant is watching me and making claims I cannot verify.”

### 2.2 The product promise

For the individual:

> **Walk into the engagement prepared. Walk out without writing a status update.**

For the team:

> **Shared memory stays current without manual reporting.**

For a team lead:

> **Pulse shows what moved, what stalled, and what needs help without measuring people’s busyness.**

---

## 3. UX principles

### 3.1 Calm by default

The default UI should show only the information required for the user’s next decision. Every screen should prefer one clear next action over simultaneous dashboards.

Rules:

- Default pages should avoid more than three major content groups above the fold.
- Metrics should be secondary to narrative.
- The UI should not expose every object type in navigation.
- Details are available, but rarely front-loaded.

### 3.2 One dominant action per screen

Every major screen must answer:

> **What should I do next?**

There may be secondary actions, but only one primary action should visually dominate.

Examples:

- Today: “Review Beta Health changes.”
- Organization: “Prepare for architecture workshop.”
- Initiative: “Confirm data residency requirement.”
- Engagement Review: “Approve eligible changes.”
- Pulse: “Unblock security review delays.”

### 3.3 Narrative before metrics

Pulse, summaries, and status areas should begin with a short explanation, not a chart wall.

Poor:

```text
23 Advancing
8 At Risk
5 Stalled
4 Needs Help
```

Better:

```text
Most active initiatives moved forward this week, but security review and data access are now the top blockers. Two commitments need lead intervention before next Friday.
```

Then show the numbers as evidence.

### 3.4 Progressive disclosure over card sprawl

Throughline should reveal deeper information only when it helps the user act or verify.

Default view:

```text
Summary
Next action
Open risk
Recent change
```

On demand:

```text
Full timeline
All claims
All accepted facts
All source artifacts
All tasks
All documents
All people
All conflicts
Audit trail
Agent trace
```

### 3.5 Evidence on demand, not evidence everywhere

Every material assertion needs a visible evidence affordance, but the default screen should not be filled with citations.

Required affordances:

- “Why?”
- “Source”
- “Confidence”
- “Accepted by”
- “Changed from”
- “Show conflict”

The evidence panel must reveal the source excerpt, accepted fact, confidence, freshness, approving actor, and permission state.

### 3.6 Agentic, not chat-first

The assistant should be ambient throughout the product. It should appear as:

- universal command/search;
- contextual actions;
- compact suggestions;
- inline explanations;
- review helpers;
- prebrief generation;
- follow-up drafting.

It should not appear as a permanent chat wall occupying the right side of every page.

### 3.7 Trust through bounded agency

The agent may prepare, interpret, propose, draft, and explain freely within policy. It may not silently change shared truth, send external communications, or commit the team.

The UI must make that boundary visible:

```text
Drafted by Throughline
Proposed, not accepted
Requires approval
Accepted by Jordan Lee
Sent nowhere yet
```

### 3.8 Pull-request review, not data entry

Engagement Review should feel like reviewing a clean pull request:

- proposed change;
- why it matters;
- supporting source;
- impact;
- conflict or supersession;
- accept/edit/drop/escalate.

The user should not feel like they are filling out CRM fields.

### 3.9 Pulse is an unblocking tool, not surveillance

Pulse must describe the state of work, not the busyness of people.

Allowed:

- initiatives advanced;
- initiatives stalled;
- blockers recurring;
- commitments at risk;
- owners needed for action;
- leadership unblock requests.

Not allowed in v1:

- individual meeting counts;
- activity rankings;
- productivity scores;
- “top performers”; 
- visible surveillance-style “engagement volume by person.”

### 3.10 Accessible from the beginning

The product must meet WCAG 2.2 AA intent for the Phase 0/1 flows. Keyboard interaction is especially important because Engagement Review is a high-volume workflow.

---

## 4. V1 navigation model

The v1 top-level shell is intentionally simple:

```text
Today
Organizations
Pulse
```

Universal command/search is always available.

Do not use this v1 sidebar:

```text
Today
Organizations
Initiatives
Engagements
Knowledge
Pulse
Tasks
Documents
Settings
```

Those objects exist, but they are reached through context rather than exposed as equal primary destinations.

### 4.1 Why this matters

A broad sidebar makes Throughline feel like a CRM or SharePoint replacement before the core wedge is proven. The first experience should tell the user:

```text
Here is what needs your attention.
Here is what we believe about this organization.
Here is what changed across the team.
```

not:

```text
Here are all database objects you can browse.
```

### 4.2 Shell anatomy

Each page should share this structure:

```text
Top bar
  Product mark
  Universal command/search
  Notifications
  User menu

Left nav
  Today
  Organizations
  Pulse
  Settings hidden under user/admin menu unless needed

Main surface
  One screen-specific narrative/action hierarchy

Context drawer
  Closed by default
  Opens for evidence, assistant, source preview, trace, or details
```

### 4.3 Context drawer rule

The right rail is not permanent. It opens when the user asks for detail or when a specific workflow requires side-by-side verification.

Good uses:

- source preview during Engagement Review;
- “Why?” evidence panel;
- draft follow-up preview;
- compact assistant thread after command invocation;
- conflict comparison;
- agent trace for advanced users.

Bad uses:

- always-on chatbot;
- generic tips panel on every screen;
- duplicate cards already present in the main surface;
- noisy AI commentary.

---

## 5. Screen specifications

## 5.1 Today

### Purpose

Today answers:

> **What needs my attention now?**

### Primary user jobs

- Start the day with clarity.
- Prepare for the next engagement.
- Review proposed changes.
- Capture quick input.
- See commitments that may slip.
- Act on one recommended next move.

### Default hierarchy

```text
1. Primary action card
2. Needs attention stack
3. Upcoming engagement / prebrief
4. Quick capture
5. Commitments at risk
6. Recent meaningful changes, collapsed
```

### Content model

#### Primary action card

One dominant card at the top.

Examples:

```text
Review Beta Health engagement changes
3 consequential items, 11 routine items, 1 escalation
```

```text
Prepare for Acme architecture workshop
Starts in 38 minutes · prebrief ready
```

```text
Confirm Atlas Bio security owner
Blocks Security Review milestone
```

#### Needs attention stack

Includes:

- Engagement reviews awaiting user;
- escalations assigned to user;
- commitments due or at risk;
- conflicts that affect current initiatives;
- permission or evidence issues needing review.

Limit visible items to 3 by default. Include “Show all.”

#### Upcoming engagement / prebrief

Show only the next one or two upcoming engagements.

Each row:

```text
Title
Organization / initiative
Time
Prebrief status: Ready / Needs context / Not generated
Primary action: Open prebrief
```

#### Quick capture

Quick capture must be visible on Today.

Input methods:

- note;
- paste transcript;
- upload file;
- voice memo.

Default text:

```text
Capture something from a meeting, email, or note...
```

The product must feel complete when no recording exists.

#### Recent meaningful changes

This is not an activity feed. Show only meaningful changes:

- fact accepted;
- commitment created;
- initiative stage changed;
- blocker emerged;
- new research signal;
- conflict resolved.

Collapse by default if there are no urgent items.

### Avoid

- charts;
- broad KPI cards;
- full task manager;
- permanent assistant rail;
- activity stream of every edit;
- per-person activity.

### Empty state

```text
No trusted memory yet.
Capture an engagement, create an organization, or import research to start building the team memory.
```

Primary actions:

```text
Create organization
Quick capture
Connect Account Research
```

---

## 5.2 Organizations list

### Purpose

Organizations answers:

> **Where is active work happening, and what needs attention?**

### Default hierarchy

```text
1. Search / filter bar
2. Quiet list grouped by attention state
3. Recently active organizations
4. Archived / inactive behind filter
```

### Row anatomy

Each organization row should show:

```text
Organization name
Relationship: customer / partner / both
Active initiatives count
Current state: Calm short phrase, not raw status
Last meaningful change
Next action
Health signal
```

Example:

```text
Beta Health
Customer · 2 initiatives
AI Governance Assessment needs data-access confirmation.
Last change: 2 accepted commitments from May 16 review
Next: Review engagement changes
```

### Filters

- relationship type;
- owner;
- initiative stage;
- health;
- stale/no recent engagement;
- has review pending;
- partner involved;
- readiness gap.

### Avoid

- CRM-style dense table by default;
- too many columns;
- revenue/forecast fields in v1;
- research provider as primary identity.

---

## 5.3 Organization detail

### Purpose

Organization detail answers:

> **What do we currently believe about this account or partner, and what is active?**

### Default hierarchy

```text
1. Cited current summary
2. Recommended next action
3. Active initiatives
4. Open commitments
5. Key people
6. Recent meaningful changes
7. Progressive sections
```

### Header

```text
Organization name
Relationship type
Health / current attention state
Last meaningful update
```

Avoid logo-heavy dashboards. Logos may appear but should not dominate.

### Current summary

One paragraph, generated from AcceptedFacts only unless explicitly labeled inference.

The summary should include a small evidence affordance:

```text
Why this summary?
```

When clicked, open an evidence drawer with:

- input facts;
- source citations;
- confidence/freshness;
- unresolved conflicts;
- generated-at timestamp;
- audience/permission context.

### Recommended next action

One action only.

Examples:

```text
Prepare for Architecture Workshop
Review 8 proposed facts
Confirm sponsor for AI Governance initiative
```

### Active initiatives

Show up to 3 active initiatives by default.

Each card:

```text
Title
Stage
Evidence challenge or confirmation
Next milestone
Open commitments count
```

### Key people

Show only people who are relevant to current work:

- executive sponsor;
- decision owner;
- technical owner;
- blocker owner;
- partner contact;
- internal initiative owner.

Do not show a generic contact database by default.

### Progressive sections

These are collapsed or tabbed below the initial view:

- Initiatives;
- Timeline;
- People;
- Use Cases;
- Readiness;
- Knowledge;
- Tasks and Commitments;
- Facts and Claims;
- Sources;
- Audit.

Default user sees the first seven. Advanced evidence/audit sections are discoverable but not visually dominant.

---

## 5.4 Initiative detail

### Purpose

Initiative detail answers:

> **What are we trying to move forward, what evidence supports the stage, and what should happen next?**

### Default hierarchy

```text
1. Initiative title + stage
2. Evidence score / challenge
3. Current objective
4. Next milestone
5. Open commitments
6. Risks/blockers
7. Recent engagements
8. Use cases / readiness gaps
9. Related knowledge
```

### Stage and evidence challenge

The human-set stage and agent evidence assessment should sit together.

Example:

```text
Stage: Solution Proposed
Evidence: Strong, but missing customer validation of security architecture.
```

If the agent challenges the stage, show a calm warning:

```text
Evidence challenge
This initiative is marked Solution Proposed, but no accepted fact confirms customer validation of the proposed architecture.
```

Primary actions:

```text
Capture validation
Review evidence
Change stage
```

### Risks and blockers

Show only blockers that affect next movement.

Each blocker should connect to:

- accepted fact or claim;
- owner;
- next action;
- due date if known;
- confidence/freshness.

### Related engagements

Show recent engagement summaries as a timeline, but default to meaningful events only.

Example:

```text
May 16 · Architecture Workshop
2 commitments accepted · security validation gap identified
```

### Avoid

- Salesforce-style field density;
- probability/forecast fields unless later CRM solution requires them;
- every engagement note shown inline;
- multiple competing next actions.

---

## 5.5 Engagement prebrief

### Purpose

Prebrief answers:

> **What should I know before this engagement?**

### Default hierarchy

```text
1. Engagement objective
2. What changed since last touch
3. Open commitments
4. Stakeholder notes
5. Suggested questions
6. Risks / unresolved conflicts
7. Source-backed current summary
```

### Interaction

The prebrief should be a readable narrative with evidence affordances, not a long data panel.

Primary actions:

```text
Start capture
Copy agenda
Draft follow-up outline
Ask why
```

### Evidence rule

Every material assertion must be source-backed or labeled inference.

### Empty state

If there is limited memory:

```text
Throughline has limited accepted memory for this engagement.
You can still capture notes and build the record afterward.
```

---

## 5.6 Quick capture

### Purpose

Quick capture answers:

> **How do I get messy work into Throughline with minimal friction?**

### Capture entry points

- Today quick capture;
- Organization detail;
- Initiative detail;
- Engagement page;
- global command;
- mobile later.

### Input modes

```text
Type note
Paste transcript or email
Upload file
Record voice memo
Link existing content
```

### Required fields

Keep required fields minimal:

```text
Content
Optional organization
Optional initiative
Optional engagement
```

If organization/initiative are unknown, Throughline can propose matches after extraction. The user should not be blocked by classification work before capture.

### Post-capture states

```text
Captured
Extracting
Review ready
Needs more context
Extraction failed
```

### Capture success message

```text
Captured. Throughline is extracting proposed changes. Nothing will update shared memory until you review it.
```

This reassures the user that capture is safe.

---

## 5.7 Engagement Review

### Purpose

Engagement Review answers:

> **What changed, what should become shared memory, and what requires judgment?**

This is the most important UX surface in Phase 0/1.

### Design target

The review should feel like:

```text
A clean pull request for team memory
```

not:

```text
A data-entry form
```

### Default layout

```text
Header
  Engagement title
  Organization / initiative
  Capture source count
  Review status

Review body
  Needs attention
  Ready to accept
  Needs another approver
  Not proposed / audit-only

Right drawer, closed or contextual
  Source preview
  Why this matters
  Prior fact comparison
  Conflict details

Footer bar
  selected count
  accept eligible
  save for later
  submit approved changes
```

### Review groups

#### Needs attention

Contains operations that are consequential, conflicting, low-confidence but material, or superseding existing truth.

Always includes:

- customer/partner commitments;
- internal commitments assigned to someone else;
- dates and deadlines;
- owners and assignees;
- stage/health changes;
- readiness/security/legal/governance claims;
- commercial terms;
- access/classification changes;
- conflict with current facts;
- fact supersession;
- external action drafts;
- source ambiguity;
- model uncertainty above the routine threshold.

Default state: expanded.

#### Ready to accept

Contains routine or material changes that the current reviewer is authorized to approve and that do not require special attention.

Examples:

- artifact links;
- topic tags;
- routine descriptive claims;
- confirmed attendees;
- non-sensitive relationship updates;
- duplicate grouping;
- summary wording changes.

Default state: collapsed summary with sample items.

Primary action:

```text
Accept all eligible routine items
```

#### Needs another approver

Contains items the reviewer can inspect but not approve.

Examples:

- stage changes requiring initiative owner;
- access-class changes requiring workspace admin;
- external action requiring explicit owner approval.

Default state: collapsed unless urgent.

Rule:

> Escalations must not block the rest of the batch.

#### Not proposed / audit-only

Contains duplicate, unsupported, low-confidence, or rejected-by-policy observations.

Default state: collapsed.

Purpose:

- preserve transparency;
- show why the agent did not propose something;
- support evaluation/debugging;
- avoid cluttering the main review.

### Operation row anatomy

Each proposed operation row should include:

```text
Type badge
Proposed change
Evidence excerpt
Confidence
Impact
Conflict / supersession indicator
Required approver
Actions: Accept, Edit, Drop, Escalate, Open source
```

### Evidence drawer

The source preview should show:

- source title;
- source type;
- captured date;
- verified excerpt;
- surrounding context;
- source trust class;
- chunk/locator;
- who captured it;
- related accepted facts;
- conflict comparison.

### Review actions

#### Accept

Accepts the operation exactly as proposed.

#### Edit

Opens an inline editor with source visible. Edits must preserve source relationship or force a “needs evidence” state.

#### Drop

Rejects operation. Requires optional reason:

```text
Incorrect
Duplicate
Unsupported
Wrong entity
Not useful
Sensitive / should not store
Other
```

#### Escalate

Routes operation to required authority. Reviewer can continue.

#### Accept eligible

Accepts all operations the current reviewer is authorized to accept in the “Ready to accept” group.

### Final submit screen

Before committing:

```text
You are about to apply:
- 9 accepted facts
- 3 commitments
- 2 tasks
- 1 relationship update
- 4 routine links/tags

2 items will remain pending escalation.
1 item was dropped.
```

Primary action:

```text
Apply approved changes
```

### Completion screen

After submit:

```text
Changes applied
9 facts accepted
3 commitments created
2 tasks created
2 escalations routed
1 derived summary regenerated
```

Include links:

```text
View organization summary
View initiative
Draft follow-up
Open audit trail
Undo eligible changes
```

### Keyboard model

Minimum keyboard shortcuts for review:

```text
J / K        next / previous operation
Enter        open operation details
A            accept selected operation
E            edit selected operation
D            drop selected operation
S            escalate selected operation
X            select / deselect
Shift+A      accept all eligible routine items
/            search within review
Esc          close drawer / cancel modal
?            show shortcuts
```

All shortcuts must have visible alternatives.

### Accessibility requirements

- Review groups are semantic sections.
- Operation list supports roving focus or standard tab order.
- Impact and status are not color-only.
- Source drawer traps focus when modal, or is navigable when persistent.
- Live region announces extraction/review status changes.
- Bulk actions include confirmation text.
- No drag-only interactions.

---

## 5.8 Follow-up draft

### Purpose

Follow-up draft answers:

> **What should we say next, based only on approved memory?**

### Rules

- The agent may draft but not send.
- Drafts use AcceptedFacts, approved decisions, and approved commitments by default.
- Unresolved items can be included only when labeled as unresolved.
- Customer-visible commitments must be approved before appearing as confirmed commitments.

### Layout

```text
Draft body
Source-backed chips for each material statement
Commitments included
Open questions
Unresolved items omitted / included with labels
```

Actions:

```text
Copy draft
Export draft
Edit
Show sources
```

No send action in Phase 1.

---

## 5.9 Pulse

### Purpose

Pulse answers:

> **What advanced, what stalled, what changed, what needs help, and what pattern is emerging?**

### Default hierarchy

```text
1. Narrative brief
2. Needs help / unblock requests
3. Movement since last period
4. Top blockers
5. Strategic patterns
6. Commitments at risk
7. Supporting metrics
```

### Narrative-first model

Pulse should open with a human-readable summary:

```text
Momentum improved this week. Three AI infrastructure initiatives advanced after architecture reviews, but data access and security validation are now blocking the highest-value work. Two initiatives need leadership help to confirm owners before next week.
```

Then provide evidence links.

### Pulse sections

#### What advanced

Shows initiatives with meaningful movement:

- stage changed;
- milestone completed;
- commitment accepted;
- blocker resolved;
- customer validation captured.

#### What stalled

Shows initiatives with insufficient movement or blockers:

- no meaningful engagement;
- overdue commitment;
- missing owner;
- contradictory accepted facts;
- stage challenged by evidence.

#### What needs help

Shows lead-level interventions:

- unblock data access;
- find executive sponsor;
- align partner role;
- route governance review;
- bring in security SME.

#### What is repeating

Shows patterns with minimum support threshold.

Example:

```text
Data readiness is now a recurring blocker across 4 active initiatives.
```

Do not overclaim from small data. Label as “early signal” when support is limited.

### Metrics rules

Allowed:

- initiative counts by state;
- commitments at risk;
- blockers by category;
- trend over time;
- pattern support count.

Not allowed:

- meeting counts by person;
- notes captured by person;
- productivity rankings;
- activity league tables.

### Evidence

Every material Pulse statement must link to accepted facts, activities, commitments, or explicit inference.

### Export/share

Phase 1 can generate a leadership brief draft, but it must be editable and source-backed.

---

## 6. Universal command and agent interaction

## 6.1 Command/search bar

The command bar is always visible or one keyboard shortcut away.

Placeholder:

```text
Search or ask Throughline...
```

Keyboard shortcut:

```text
Cmd/Ctrl + K
```

### Modes

The command bar supports:

```text
Search
Ask
Action
Capture
Navigate
Explain
```

Examples:

```text
Search: Acme governance commitments
Ask: Why is Beta Health marked at risk?
Action: Prepare me for tomorrow’s architecture workshop
Capture: Add note from today’s call
Navigate: Open Atlas Bio security review
Explain: Why did Throughline recommend this action?
```

### Result types

- direct navigation result;
- source-backed answer;
- action proposal;
- capture prompt;
- draft generation;
- explanation;
- denied/insufficient permission result.

### Agent result format

Every agent result should show:

```text
Answer or proposed action
Basis: accepted facts / claims / sources
Confidence or uncertainty
What it can do next
What requires approval
```

### No anthropomorphic agent cast

Do not use named internal agents. The user sees Throughline as one assistant.

Avoid:

```text
Scout found...
Professor thinks...
Orion recommends...
```

Use:

```text
Throughline found...
Based on accepted facts...
This requires approval...
```

### Do not simulate emotion

Throughline should be competent, calm, and precise. It should not pretend to have feelings, personality, or social intimacy.

---

## 7. Evidence, provenance, and trust UX

## 7.1 Trust state labels

Throughline needs a small, consistent trust language.

Suggested labels:

```text
Accepted
Proposed
Contested
Superseded
Revoked
Inference
Unverified source
Restricted
Stale
```

### Accepted

Human-approved organizational memory.

### Proposed

Extracted or suggested, not yet shared truth.

### Contested

Conflicting claims or accepted facts exist.

### Superseded

No longer current but retained for history.

### Inference

Generated interpretation from accepted facts; not directly stated in a source.

### Stale

Time-sensitive or freshness-expired.

## 7.2 Evidence affordance

Every material statement should expose a compact affordance:

```text
Why?
```

On click:

```text
This is based on:
- Accepted fact: Beta Health requested AI incident response playbook
- Source: Project Update Email, May 13
- Excerpt: “We will implement the AI incident response playbook by August 1.”
- Accepted by: Alex Morgan
- Confidence: Strong
- Access: Workspace
```

## 7.3 Citation UX warning

Do not rely on citation presence alone to build trust. Users may overtrust clean-looking AI answers with citations without checking them. The UI should make verification fast and should surface uncertainty and conflicts near the claim, not hidden deep in an audit trail.

## 7.4 Source preview rules

A source preview must:

- show exact server-verified excerpt;
- show surrounding context on request;
- show source type and captured date;
- show who captured/imported it;
- show trust class;
- show access class;
- avoid exposing unauthorized content;
- never show a model-invented excerpt.

---

## 8. Information density rules

The visual mockups failed mainly on density. Use these constraints.

### 8.1 Default screen density

A default screen should have:

- one primary action;
- no more than three major sections above the fold;
- no more than one metrics group above the fold;
- no permanent right rail;
- no more than five visible cards unless the page is a list.

### 8.2 Card rules

Cards should be used sparingly.

A card is allowed when it represents:

- a required decision;
- a current initiative;
- a prebrief;
- a review batch;
- a blocker;
- a concise narrative summary.

Avoid cards for:

- every metric;
- every task;
- every document;
- every person;
- generic status widgets.

### 8.3 Color rules

Use color semantically and sparingly.

Suggested semantic roles:

```text
Blue: primary action / navigation
Green: accepted / healthy / complete
Amber: attention / needs review
Red: consequential risk / blocked / denied
Purple: agent-generated / derived / inference
Gray: inactive / supporting metadata
```

Color must not be the only indicator.

### 8.4 Typography rules

- Body text should be readable at 14-16px minimum.
- Use clear hierarchy: page title, summary, section title, item title, metadata.
- Metadata should be muted but legible.
- Avoid all-caps except tiny status labels, and even there use sparingly.

### 8.5 Empty space is functional

Whitespace is not decoration. It communicates focus and prevents the product from becoming another noisy enterprise application.

---

## 9. State design

## 9.1 Empty states

Empty states should explain how memory is built.

Examples:

```text
No accepted facts yet.
Capture an engagement or import research to start building trusted memory.
```

```text
No Pulse yet.
Pulse appears after Throughline has accepted facts, commitments, or initiative movement to summarize.
```

```text
No active initiatives.
Create an initiative to connect engagements, use cases, commitments, and decisions.
```

## 9.2 Loading states

Loading states should distinguish deterministic work from agent work.

Examples:

```text
Saving source...
```

```text
Extracting proposed changes...
Nothing will update shared memory until you review it.
```

```text
Regenerating summary against current permissions...
```

## 9.3 Error states

Errors must be specific and recoverable.

Poor:

```text
Something went wrong.
```

Better:

```text
Throughline could not verify the source excerpt for 3 proposed claims.
Those claims were moved to Not Proposed. You can still review the remaining changes.
```

## 9.4 Permission-denied states

Do not reveal restricted details.

Good:

```text
You do not have access to this source.
Ask a workspace admin for access or open another source.
```

Avoid:

```text
You do not have access to “Confidential Security Review - Atlas Bio.pdf.”
```

if the title itself is restricted.

## 9.5 Degraded integration states

Throughline must remain useful when integrations fail.

Example:

```text
Account Research is unavailable.
You can still capture engagements, review proposed changes, and update trusted memory. Research refresh will resume when the adapter is healthy.
```

## 9.6 Conflict states

Conflicts should be visible but not alarming unless they block action.

Example:

```text
Conflicting sponsor information
Current accepted fact: Priya Shah is executive sponsor.
New claim: Michael Chen is executive sponsor.
Action: Review source and decide whether to supersede.
```

## 9.7 Stale states

Stale facts should be labeled and should not silently poison summaries.

Example:

```text
This governance posture was last validated 94 days ago.
```

Actions:

```text
Ask to confirm
Mark still current
Capture update
```

---

## 10. Accessibility and keyboard requirements

### 10.1 Standard

Phase 0/1 UI should target WCAG 2.2 AA intent.

### 10.2 Keyboard-first review

Engagement Review must be fully keyboard-operable. A user should be able to review a transcript-sized batch without leaving the keyboard.

Required:

- visible focus indicators;
- predictable tab order;
- keyboard shortcuts with discoverable help;
- no drag-only controls;
- bulk actions accessible by button and keyboard;
- modals/drawers with proper focus management;
- live regions for extraction and apply status.

### 10.3 ARIA patterns

Use native HTML first. Use WAI-ARIA APG patterns for custom widgets only when needed.

Likely patterns:

- disclosure;
- tabs;
- dialog;
- toolbar;
- combobox;
- listbox;
- menu button;
- grid only if a true data-grid is needed.

### 10.4 Non-color indicators

Impact/status must include icons, text, or shape in addition to color.

Example:

```text
High impact · Commitment
```

not just a red dot.

### 10.5 Reduced motion

Animations should respect reduced-motion settings.

### 10.6 Screen-reader labels

All evidence/status controls need explicit labels.

Examples:

```text
Open evidence for proposed commitment
Accept proposed task
Drop proposed fact
Escalate to initiative owner
```

---

## 11. Revised low-clutter wireframe descriptions

These are textual wireframes to replace the current cluttered concept mockups.

## 11.1 Today wireframe

```text
+-------------------------------------------------------------+
| throughline        Search or ask...                 User    |
+-------------------------------------------------------------+
| Today | Organizations | Pulse                               |
+-------------------------------------------------------------+
| Today                                                       |
| Focus on what needs attention now.                          |
|                                                             |
| + Primary action -----------------------------------------+ |
| | Review Beta Health engagement changes                   | |
| | 3 consequential · 11 routine · 1 escalation              | |
| | [Open review]                                           | |
| +---------------------------------------------------------+ |
|                                                             |
| + Upcoming -----------------------------------------------+ |
| | Acme Architecture Workshop · 10:00 AM · Prebrief ready   | |
| | [Open prebrief]                                         | |
| +---------------------------------------------------------+ |
|                                                             |
| + Quick capture ------------------------------------------+ |
| | Capture note, paste transcript, upload, or voice memo    | |
| | [Start capture]                                         | |
| +---------------------------------------------------------+ |
|                                                             |
| Commitments at risk (2)       Recent changes (collapsed)    |
+-------------------------------------------------------------+
```

## 11.2 Organization wireframe

```text
+-------------------------------------------------------------+
| Acme Corp                                      [Prepare me] |
| Current trusted summary · Why?                            |
| Acme is modernizing its AI platform...                     |
+-------------------------------------------------------------+
| Recommended next action                                    |
| Confirm data residency requirements before proposal review. |
| [Draft question] [Show evidence]                           |
+-------------------------------------------------------------+
| Active initiatives                                         |
| - AI Platform Modernization · Solution Proposed · Strong    |
| - AI Governance Workshop · Workshop · Missing sponsor       |
+-------------------------------------------------------------+
| Key people                 Open commitments                 |
| Priya Shah · Sponsor       Security review · due May 23     |
| Jordan Lee · Owner         Data access · due May 20         |
+-------------------------------------------------------------+
| Recent meaningful changes                                  |
| May 16 · 2 commitments accepted from Architecture Workshop  |
+-------------------------------------------------------------+
| Sections: Initiatives · Timeline · People · Use Cases · ... |
+-------------------------------------------------------------+
```

## 11.3 Initiative wireframe

```text
+-------------------------------------------------------------+
| AI Platform Modernization                  [Open action plan]|
| Stage: Solution Proposed    Evidence: Strong, missing X      |
+-------------------------------------------------------------+
| Current objective                                           |
| Validate architecture and secure proposal approval.          |
+-------------------------------------------------------------+
| Next milestone                                              |
| Proposal approval · May 22                                  |
+-------------------------------------------------------------+
| Open commitments        Risks/blockers       Recent events   |
| Data access             Data residency       Workshop        |
| Security review         Connector roadmap    Assessment      |
+-------------------------------------------------------------+
| Use cases proposed          Readiness posture                |
| Unified ML platform         Data governance: established     |
| Model lifecycle             Security validation: planned     |
+-------------------------------------------------------------+
```

## 11.4 Engagement Review wireframe

```text
+-------------------------------------------------------------+
| Beta Health - AI Governance Assessment                      |
| Review proposed changes. Nothing updates until approved.     |
+-------------------------------------------------------------+
| Needs attention (3)                                         |
| 1. Customer commitment · High impact                         |
|    Implement AI incident response playbook by Aug 1          |
|    Evidence: "We will implement..." [Source]                |
|    [Accept] [Edit] [Drop] [Escalate]                        |
|                                                             |
| 2. Deadline change · Medium impact                           |
|    Risk assessment due date moved to Jun 30                  |
|    [Accept] [Edit] [Drop]                                   |
+-------------------------------------------------------------+
| Ready to accept (11) [Accept all eligible] [Expand]          |
+-------------------------------------------------------------+
| Needs another approver (1) [Route to initiative owner]       |
+-------------------------------------------------------------+
| Not proposed / audit-only (5) [Expand]                      |
+-------------------------------------------------------------+
| Footer: 14 selected · 11 routine · 3 attention               |
| [Save for later] [Apply approved changes]                    |
+-------------------------------------------------------------+
```

## 11.5 Pulse wireframe

```text
+-------------------------------------------------------------+
| Pulse                                                       |
| What advanced, stalled, and needs help.                     |
+-------------------------------------------------------------+
| Narrative brief                                             |
| Momentum improved this week, but security review and data    |
| access are blocking the highest-value initiatives.           |
+-------------------------------------------------------------+
| Needs help                                                  |
| 1. Unblock security review for 3 initiatives                 |
| 2. Confirm data owners for Beta Health and Atlas Bio         |
+-------------------------------------------------------------+
| What advanced             What stalled                      |
| 4 initiatives moved       2 initiatives lack sponsor         |
| 2 workshops completed     3 commitments overdue              |
+-------------------------------------------------------------+
| Patterns                                                    |
| Data readiness is recurring across 4 initiatives.            |
| [Show evidence]                                             |
+-------------------------------------------------------------+
```

---

## 12. Component rules

### 12.1 Status badges

Status badges must be short and semantic.

Examples:

```text
Accepted
Proposed
Needs review
Needs approver
Contested
Stale
Restricted
```

### 12.2 Impact badges

Impact badge is policy-assigned, not model-assigned.

Examples:

```text
Routine
Material
Consequential
Restricted
```

Always pair with operation type:

```text
Consequential · Customer commitment
```

### 12.3 Evidence button

Use consistent labels:

```text
Why?
Source
Show evidence
```

Do not use inconsistent labels like “Details,” “Info,” and “Evidence” interchangeably.

### 12.4 Source preview

Use a single reusable source preview component across:

- prebrief;
- summary;
- review;
- Pulse;
- search answer;
- agent response.

### 12.5 Toasts

Toasts should never be the only place critical information appears.

Good toast:

```text
9 changes applied. 2 escalations routed.
```

Permanent location:

- Engagement Review completion state;
- activity timeline;
- audit trail.

### 12.6 Undo / compensation

Where compensation is available:

```text
Undo applied changes
```

When not available:

```text
Undo unavailable. This change requires a new superseding operation.
```

---

## 13. Acceptance criteria

## 13.1 Product feel

- The default Today screen can be understood in five seconds.
- No primary screen shows more than one dominant action.
- The assistant does not appear as a permanent chat wall.
- The UI feels calm with real data, not just empty mock data.
- A user can tell what is trusted, what is proposed, and what is contested.

## 13.2 Engagement Review

- A transcript-sized batch of 30-50 operations can be reviewed without opening every routine item.
- Consequential items are impossible to miss.
- Source evidence is one action away for every proposed claim.
- A user can accept all eligible routine items.
- A user can edit, drop, or escalate individual items.
- Escalations do not block batch completion.
- Final submit clearly previews what will change.
- Completion state shows applied, escalated, and failed operations.
- Review is demonstrably faster than manual meeting write-up and record updates.

## 13.3 Trust and explainability

- Every material summary, recommendation, Pulse statement, or agent answer can reveal source, confidence, freshness, approval state, and audience/permission context.
- Citation UI does not imply certainty where uncertainty exists.
- Conflicts and supersession are visible where they affect a decision.
- Permission-denied states do not leak restricted titles or counts.

## 13.4 Agent interaction

- Users can invoke “Prepare me,” “Capture what changed,” “Explain why,” and “Draft follow-up” contextually.
- Agent outputs clearly distinguish accepted facts, proposed claims, source material, and inference.
- The agent never suggests it has sent something when it has only drafted it.
- The agent never anthropomorphizes internal workers or exposes a cast of agents.

## 13.5 Pulse

- Pulse begins with narrative, not metrics.
- Pulse measures state of work, not person activity.
- Pulse highlights blockers and unblocking actions.
- Every material Pulse statement is evidence-backed or explicitly labeled inference.

## 13.6 Accessibility

- All primary flows are keyboard-operable.
- Focus is visible and not obscured.
- Status is not color-only.
- Review groups and operations are screen-reader navigable.
- Drawer/modal focus behavior is correct.
- Touch targets meet WCAG 2.2 AA intent.

---

## 14. UX implementation sequencing

Do not build the entire UI at once.

### UX P0-A: Design tokens and shell

- basic layout shell;
- Today / Organizations / Pulse nav;
- command/search placeholder;
- typography, spacing, surfaces, and status tokens;
- empty states.

### UX P0-B: Manual organization and engagement

- create organization;
- create initiative;
- create engagement;
- quick capture note/paste;
- source captured state.

### UX P0-C: Engagement Review vertical slice

- review groups;
- operation rows;
- source drawer;
- accept/edit/drop/escalate;
- accept eligible;
- final submit;
- completion state.

### UX P0-D: Trusted summaries

- cited organization summary;
- “Why?” evidence panel;
- regenerated summary after fact/permission change;
- denied state.

### UX P0-E: Today and minimal Pulse

- Today review cards;
- quick capture;
- upcoming engagement/prebrief placeholder;
- minimal Pulse narrative;
- evidence links.

---

## 15. Explicit changes from current mockups

The mockups should not be thrown away, but they should not define implementation.

### Keep

- clean visual tone;
- generous spacing;
- simple brand mark;
- left navigation concept;
- engagement-review grouping concept;
- source preview concept;
- evidence-backed organizational summary;
- Pulse as team/leadership surface.

### Change

- Reduce top-level nav to Today, Organizations, Pulse.
- Remove always-visible assistant rail.
- Reduce card count by 40-60% on default screens.
- Make Today action-first, not dashboard-first.
- Make Pulse narrative-first, not metric-first.
- Add quick capture prominence.
- Add “Needs another approver” as a first-class review group.
- Add evidence drawer as the reusable trust surface.
- Use progressive disclosure for people, documents, use cases, tasks, and timeline.
- Remove per-person activity cues.

---

## 16. Open UX questions before high-fidelity design

These should be answered by prototype testing, not more architecture debate.

1. Does Today feel useful with only one organization and one engagement?
2. Can users review 30-50 proposed operations without fatigue?
3. Is “Needs another approver” understood without explanation?
4. Does the evidence drawer build trust or create clutter?
5. Does quick capture feel safe enough to use during/after real meetings?
6. Does Pulse feel like unblocking, not surveillance?
7. Does the command bar feel powerful without becoming the whole product?
8. How much source context is enough to verify a claim without opening the full artifact?
9. Should “Ready to accept” be collapsed by default for all users or only after onboarding?
10. Can a first-time user understand Accepted vs Proposed vs Contested?

---

## 17. Prototype test script

Use a clickable prototype before implementing the full front end.

### Test scenario

A user starts the day, prepares for an engagement, captures messy notes, reviews proposed changes, updates trusted memory, and sees Today/Pulse update.

### Tasks

1. Open Today and identify the most important action.
2. Open a prebrief for an upcoming engagement.
3. Quick capture a pasted transcript.
4. Open Engagement Review.
5. Find the consequential customer commitment.
6. Verify the source.
7. Accept routine items without reviewing all of them.
8. Edit one due date.
9. Escalate one item to the initiative owner.
10. Apply approved changes.
11. Open organization summary and explain why it changed.
12. Open Pulse and identify what needs help.

### Success criteria

- User understands Today in under five seconds.
- User can explain what is trusted vs proposed.
- User finds source evidence without prompting.
- User does not open every routine item.
- User understands that escalated items do not block completion.
- User does not describe Pulse as employee monitoring.
- User trusts the agent more because it shows boundaries, not because it sounds confident.

---

## 18. Claude/Codex handoff prompt

Use this when asking for review or implementation planning:

```text
Review the attached Throughline UX and Interaction Specification v0.1 as a product designer and front-end architect. Do not broaden the product or add new top-level surfaces. Challenge whether the UX is calm enough, whether the Engagement Review flow can handle 30-50 operations without fatigue, whether the agent surface is too loud or too hidden, and whether Pulse avoids surveillance. Return only concrete UX changes that should be made before implementation.
```

For Codex implementation:

```text
Implement the Phase 0 Throughline UI using the UX spec, not the earlier visual mockups. Build the shell with Today, Organizations, and Pulse only. Use a universal command/search affordance. Do not implement a permanent assistant rail. Prioritize the Engagement Review workflow with Needs attention, Ready to accept, Needs another approver, evidence drawer, source preview, accept/edit/drop/escalate, accept eligible, final submit, and completion state. Keep default screens calm and progressive-disclosure driven.
```

---

## Appendix A: Do / do not summary

### Do

- Show one primary action.
- Use progressive disclosure.
- Make quick capture first-class.
- Make evidence one action away.
- Make review batch-oriented.
- Make Pulse narrative-first.
- Keep the assistant ambient.
- Make uncertainty visible.
- Use accepted facts as the basis for summaries.
- Make permission and trust boundaries visible when relevant.

### Do not

- Build dashboard sprawl.
- Expose every object in the main nav.
- Keep a permanent assistant rail.
- Show per-person productivity metrics.
- Hide consequential items in routine batches.
- Require users to open every routine claim.
- Use citation badges as a substitute for verification.
- Let the agent sound like it acted externally when it only drafted.
- Make mockup density the implementation default.

---

## Appendix B: Design language draft

### Voice

Short. Direct. Calm. Specific.

Good:

```text
3 changes need your attention.
This commitment requires initiative-owner approval.
No accepted fact supports this stage yet.
```

Bad:

```text
Your AI copilot has discovered exciting new insights!
```

### Microcopy patterns

#### Proposed memory

```text
Proposed, not accepted.
```

#### Trusted memory

```text
Accepted by Alex Morgan on May 16.
```

#### Agent draft

```text
Drafted by Throughline. Not sent.
```

#### Low confidence

```text
Weak signal. Review source before accepting.
```

#### Conflict

```text
Conflicts with current accepted fact.
```

#### Permission

```text
Some sources were excluded because you do not have access.
```

#### Degraded integration

```text
Research adapter unavailable. Throughline still works with manual capture.
```

---

## Appendix C: Research references

1. Nielsen Norman Group, “Progressive Disclosure,” explains that deferring advanced or rarely used features reduces complexity and focuses attention on primary options. https://www.nngroup.com/articles/progressive-disclosure/
2. Nielsen Norman Group, “10 Usability Heuristics for User Interface Design,” includes visibility of system status, user control and freedom, recognition over recall, flexibility, error prevention, and aesthetic/minimalist design. https://www.nngroup.com/articles/ten-usability-heuristics/
3. Nielsen Norman Group, “Aesthetic and Minimalist Design,” frames minimalist design as reducing interface noise to emphasize necessary information. https://www.nngroup.com/articles/aesthetic-minimalist-design/
4. Apple Human Interface Guidelines provide current platform design guidance emphasizing clarity, hierarchy, and deference to content. https://developer.apple.com/design/human-interface-guidelines
5. Microsoft Research, “Guidelines for Human-AI Interaction,” provides evidence-based guidance for AI behavior during initial interaction, normal use, error states, and over time. https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/
6. Google People + AI Guidebook provides practical guidance for human-centered AI products, including feedback/control, explainability, and graceful failure. https://pair.withgoogle.com/guidebook/
7. Nielsen Norman Group, “Explainable AI in Chat Interfaces,” warns that users may overtrust cited AI answers and therefore source presentation must encourage verification. https://www.nngroup.com/articles/explainable-ai/
8. Nielsen Norman Group, “Prioritize Smarts over Sentience to Increase Trust with AI,” argues task-oriented AI should emphasize competence over emotional or sentient presentation. https://www.nngroup.com/articles/smarts-emotion-trust-ai/
9. W3C, “Web Content Accessibility Guidelines (WCAG) 2.2,” is the current recommendation for accessible web content. https://www.w3.org/TR/WCAG22/
10. W3C WAI, “ARIA Authoring Practices Guide,” provides accessibility semantics and keyboard interaction patterns for common widgets. https://www.w3.org/WAI/ARIA/apg/

---

## Appendix D: Final UX north star

> **Throughline is not a dashboard. It is a calm, evidence-backed work surface where messy activity becomes trusted memory and trusted memory becomes the next action.**
