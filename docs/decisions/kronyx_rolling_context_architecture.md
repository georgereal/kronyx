# Kronyx --- Persistent Conversation, Rolling Context & Memory Architecture

**Document type:** Architecture Decision Record and Implementation
Blueprint\
**Status:** Proposed / Baseline for implementation\
**Date:** 9 November 2026\
**Scope:** Persistent conversations, agentic execution continuity,
rolling context, memory retention, retrieval and compaction

------------------------------------------------------------------------

## 1. Executive summary

Kronyx will support persistent conversations that users can return to
after days, weeks or months. A conversation must retain its identity and
history across multiple agent executions, while the platform remains
conscious of model context limits, infrastructure capacity and retrieval
cost.

The design separates three concerns:

1.  **Conversation continuity** --- retain the conversation and its
    history according to configurable retention policies.
2.  **Knowledge continuity** --- extract, validate and retrieve reusable
    knowledge at conversation, project and eventually workspace scope.
3.  **Execution continuity** --- persist plans, tasks, tool operations,
    artifacts and checkpoints independently of the agent runtime.

A dedicated **Context Management Engine** reconstructs the relevant
context for every LLM invocation. It does not load the entire
conversation by default. Instead, it combines current messages,
execution state, selected historical segments, validated memories and
current repository evidence within a configurable token and
infrastructure budget.

### Core architectural principle

> Retain everything that matters, but retrieve only what is relevant and
> affordable for the current execution.

Rolling context primarily controls active retrieval and compaction. It
should not automatically imply deletion of durable conversation history.

------------------------------------------------------------------------

## 2. Confirmed architectural decisions

  -----------------------------------------------------------------------
  Area                    Decision                Consequence
  ----------------------- ----------------------- -----------------------
  Conversation model      Persistent              A conversation can span
                          conversations           many days and
                                                  executions.

  Old conversation data   Hybrid retention        Keep durable raw
                                                  history where policy
                                                  permits; compact older
                                                  segments; archive
                                                  eligible data; delete
                                                  only under configured
                                                  retention/deletion
                                                  policy.

  Memory strategy         Hybrid                  Automatically extract
                                                  candidate memories,
                                                  validate and
                                                  deduplicate them, then
                                                  promote suitable
                                                  knowledge.

  Context scope           Conversation-specific   Each conversation
                          plus project-level      retains its own history
                          shared knowledge        and memory; authorized
                                                  conversations can use
                                                  shared project memory.

  Capacity management     Rolling and             Limit active context
                          budget-aware            and retrieval
                                                  independently from
                                                  durable storage
                                                  retention.

  Execution lifecycle     Independent from        An execution can
                          conversation lifecycle  finish, pause or fail
                                                  without ending the
                                                  conversation.

  Runtime dependency      Runtime is disposable   Durable state must
                                                  survive VM/container
                                                  termination.
  -----------------------------------------------------------------------

### Design implications

-   A conversation is not an execution.
-   A project is not a conversation.
-   A memory is not a message.
-   A checkpoint is not a full VM snapshot.
-   A vector database is not the source of truth.
-   Redis is a cache, not durable storage.
-   Historical summaries must retain provenance and references to source
    records.

------------------------------------------------------------------------

## 3. Architectural principles

1.  **Durable source of truth:** Persist messages, execution events,
    memory records and artifacts independently of the active runtime.
2.  **Selective context assembly:** Retrieve only relevant history and
    knowledge for each LLM invocation.
3.  **Separation of storage and retrieval:** Retention policy determines
    how long data remains available; retrieval policy determines what
    enters the active context.
4.  **Structured state before semantic search:** Use deterministic
    queries for execution status, task dependencies, decisions and
    access control. Use semantic search for suitable historical and
    knowledge retrieval.
5.  **Provenance:** Every memory should identify its source, origin
    type, confidence, scope and version.
6.  **Temporal correctness:** Support superseded decisions and changing
    project facts rather than accumulating contradictory active
    memories.
7.  **Runtime independence:** Session and execution continuity must
    survive infrastructure replacement.
8.  **Least privilege:** Memory retrieval must enforce workspace,
    project, conversation and agent authorization.
9.  **Model independence:** Context management must not be coupled to a
    specific LLM or agent SDK.
10. **Observable context:** Record what was included, excluded and
    budgeted for each context build.

------------------------------------------------------------------------

## 4. Logical architecture

The platform consists of an Agent Execution Engine and a Context
Management Engine, backed by durable persistence and infrastructure
services.

``` mermaid
flowchart TB
    U[User / Persistent Conversation] --> ORCH[Kronyx Agent Orchestrator]

    subgraph EXEC[Agent Execution Engine]
      ORCH --> PLAN[Planner]
      ORCH --> RUN[Agent Runtime]
      RUN --> TOOLS[Tool Manager]
      ORCH --> DELEGATE[Agent Delegation]
      RUN --> VM[Disposable VM / Container]
    end

    subgraph CME[Context Management Engine]
      SM[Session Manager]
      CB[Context Builder]
      CR[Context Retriever]
      RM[Rolling / Compaction Manager]
      MM[Memory Manager]
      CM[Checkpoint Manager]
      SM --> CB
      CR --> CB
      RM --> MM
    end

    ORCH <--> SM
    RUN -->|Context request| CB
    CB -->|Context package| RUN
    ORCH -->|Execution events| CM
    RUN -->|Tool and task events| CM

    subgraph DATA[Persistence Layer]
      PG[(PostgreSQL)]
      REDIS[(Redis Cache)]
      VEC[(pgvector)]
      OBJ[(Object Storage)]
      BUS[Event Bus / Queue]
    end

    SM <--> PG
    CB <--> PG
    CR <--> PG
    CR <--> VEC
    MM <--> PG
    CM <--> PG
    CB <--> REDIS
    RM <--> OBJ
    RM <--> BUS
    MM <--> BUS
    CM <--> OBJ
```

### Logical components

  -----------------------------------------------------------------------
  Component                           Responsibility
  ----------------------------------- -----------------------------------
  Session Manager                     Conversation lifecycle, activation,
                                      metadata and execution association

  Context Builder                     Construct model-ready context and
                                      enforce token budgets

  Context Retriever                   Retrieve historical segments,
                                      conversation memory, project memory
                                      and references

  Rolling Manager                     Segment conversations, compact
                                      older history and manage archival
                                      workflows

  Memory Manager                      Extract, validate, deduplicate,
                                      promote, supersede and expire
                                      memories

  Checkpoint Manager                  Persist and restore execution state

  Agent Execution Engine              Plan, reason, invoke tools,
                                      delegate and run agents

  Artifact Manager                    Store large logs, patches, files
                                      and tool outputs
  -----------------------------------------------------------------------

These are logical boundaries, not a requirement to deploy every
component as a separate microservice. Begin with modular components in a
Context Management service.

------------------------------------------------------------------------

## 5. Ownership hierarchy and identifiers

Recommended hierarchy:

``` text
Workspace
  |
  +-- Project
  |     |
  |     +-- Shared Project Memory
  |     |
  |     +-- Conversation A
  |     |     +-- Messages / Segments
  |     |     +-- Conversation Memory A
  |     |     +-- Executions
  |     |
  |     +-- Conversation B
  |     |     +-- Messages / Segments
  |     |     +-- Conversation Memory B
  |     |     +-- Executions
  |     |
  |     +-- Conversation C
  |           +-- Messages / Segments
  |           +-- Conversation Memory C
  |           +-- Executions
  |
  +-- Workspace-level policies and optional shared knowledge
```

### Identifiers

  Identifier         Meaning
  ------------------ ----------------------------------------
  `workspaceId`      Tenant or organization boundary
  `projectId`        Shared codebase and knowledge boundary
  `conversationId`   Long-lived conversation identity
  `messageId`        Individual message identity
  `segmentId`        Conversation compaction/retrieval unit
  `executionId`      One agentic execution
  `taskId`           A task within an execution
  `agentId`          Agent participating in an execution
  `checkpointId`     Durable recovery point
  `memoryId`         Knowledge record identity
  `artifactId`       Large output or file reference
  `contextId`        One assembled context package
  `contextVersion`   Version of the assembled context

A conversation can have multiple executions over time. An execution can
contain multiple tasks and agents. Multiple conversations can share
authorized project memory.

Do not make the VM, container or agent process the owner of conversation
state.

------------------------------------------------------------------------

## 6. Conversation data lifecycle and rolling storage

Use four logical lifecycle states for conversation data.

  -----------------------------------------------------------------------
  State                   Description             Typical storage
  ----------------------- ----------------------- -----------------------
  Active                  Recent messages and     PostgreSQL plus Redis
                          current execution       cache
                          context                 

  Compacted               Older messages grouped  PostgreSQL
                          into segments with      
                          summaries and source    
                          references              

  Archived                Raw messages, large     Object storage / cold
                          tool outputs and        tier
                          artifacts moved to      
                          lower-cost storage      
                          where appropriate       

  Expired                 Data removed according  Deleted, including
                          to retention and        eligible derived data
                          deletion policy         
  -----------------------------------------------------------------------

A message can be archived while a related decision remains active in
project memory. Conversation retention and memory retention must
therefore be independent.

### Two independent rolling windows

**Message window** - Controls the recent messages readily available for
context reconstruction. - Should be measured by tokens as well as
message count. - Older messages remain retrievable through segment
summaries and historical search.

**Execution window** - Controls how many executions retain detailed
state in the readily accessible tier. - Older executions can be
represented by task summaries and artifact references. - Durable records
remain subject to retention policy.

### Segment model

A segment is a logical unit for compaction and retrieval. It is not a
separate conversation.

Each segment should include: - `segmentId` - `conversationId` - sequence
number - start and end message references - raw token count - summary
token count - topics and entities - structured decisions and
constraints - related execution references - compaction status and
summary version - archival status and timestamps

Finalized segments should be immutable. Regenerate or version summaries
rather than silently changing historical source content.

### Suggested PostgreSQL DDL

``` sql
CREATE TABLE conversation_segments (
    segment_id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    sequence_number BIGINT NOT NULL,
    start_message_id UUID,
    end_message_id UUID,
    status VARCHAR(30) NOT NULL,
    raw_token_count INT,
    summary_token_count INT,
    summary JSONB,
    summary_version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    compacted_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    UNIQUE (conversation_id, sequence_number)
);

CREATE TABLE messages (
    message_id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    execution_id UUID,
    segment_id UUID,
    sequence_number BIGINT NOT NULL,
    role VARCHAR(30) NOT NULL,
    content TEXT,
    content_type VARCHAR(50),
    token_count INT,
    artifact_id UUID,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, sequence_number)
);
```

For large outputs, store an artifact reference rather than placing very
large content in the message row.

------------------------------------------------------------------------

## 7. Memory architecture and lifecycle

Kronyx should support at least two primary memory scopes and leave room
for workspace memory.

  -----------------------------------------------------------------------
  Scope                   Purpose                 Examples
  ----------------------- ----------------------- -----------------------
  Conversation memory     Knowledge specific to   User clarifications,
                          one conversation        task-specific
                                                  decisions, unresolved
                                                  questions

  Project memory          Knowledge shared across Architecture, coding
                          authorized              conventions, technology
                          conversations           choices, verified
                                                  discoveries

  Workspace memory        Organization-wide       Approved engineering
  (future)                reusable knowledge and  standards,
                          policies                workspace-level
                                                  constraints
  -----------------------------------------------------------------------

### Memory promotion pipeline

``` mermaid
flowchart TD
    A[Conversation and Execution Events] --> B[Memory Candidate Extraction]
    B --> C[Classification and Validation]
    C --> D{Scope and confidence assessment}
    D -->|Conversation-specific| E[Conversation Memory]
    D -->|Reusable project knowledge| F[Project Memory Candidate]
    D -->|Workspace-wide candidate| G[Workspace Review / Policy]
    F --> H[Deduplication and Conflict Detection]
    H --> I{Promotion justified?}
    I -->|Yes| J[Active Project Memory]
    I -->|No| K[Retain as Candidate or Conversation Memory]
```

### Promotion rules

  -----------------------------------------------------------------------
  Candidate type                      Default policy
  ----------------------------------- -----------------------------------
  Explicit user decision              Conversation memory; project
                                      candidate if reusable

  Repeated coding convention          Project memory candidate

  Temporary debugging observation     Conversation memory

  Agent inference                     Low-confidence conversation memory

  Verified architecture discovery     Project memory candidate

  Security/compliance constraint      Trusted source or explicit
                                      confirmation required
  -----------------------------------------------------------------------

Do not promote every message or tool result. Repetition alone does not
make an inferred statement authoritative.

### Memory record schema

``` json
{
  "memoryId": "mem-001",
  "workspaceId": "ws-001",
  "projectId": "proj-001",
  "conversationId": "conv-001",
  "scope": "project",
  "category": "architecture",
  "content": "The application uses CQRS with MediatR.",
  "origin": {
    "type": "verified_codebase_observation",
    "executionId": "exec-001",
    "messageIds": ["msg-101"]
  },
  "confidence": 0.97,
  "status": "active",
  "version": 1,
  "validFrom": "2026-11-09T00:00:00Z",
  "validUntil": null
}
```

Recommended additional fields: - `supersededBy` - `lastVerifiedAt` -
`embeddingModel` - `accessPolicy` - `sensitivity` - `createdBy` -
`updatedBy` - `createdAt` - `updatedAt`

### Memory lifecycle

``` text
Candidate
   |
   v
Validated
   |
   v
Active
   |
   +----> Updated / New Version
   |
   +----> Superseded
   |
   +----> Expired
   |
   +----> Deleted
```

Memory records need provenance, versioning and temporal validity. For
example, "SQL Server is the current production database" and "PostgreSQL
is the migration target" can both be valid facts. Do not collapse them
into a simplistic conflict.

------------------------------------------------------------------------

## 8. Context retrieval and assembly

Context retrieval must not be a single vector search. Use a multi-stage
pipeline.

### Stage 1 --- Deterministic retrieval

Load: - System and agent instructions. - Current user request. -
Conversation metadata. - Latest execution state. - Current task and
plan. - Pinned decisions and active constraints. - Agent permissions and
relevant policy.

### Stage 2 --- Conversation history retrieval

Retrieve: - Recent messages. - Relevant historical segments. -
Conversation summaries. - Explicitly referenced messages. - Related task
outcomes.

Use a combination of semantic similarity, keyword search, recency,
topic/entity matching and explicit references.

### Stage 3 --- Project memory retrieval

Retrieve applicable: - Architectural decisions. - Repository
conventions. - Technology stack. - Known limitations. - Previous
implementation discoveries. - Active project constraints.

### Stage 4 --- Repository and external evidence retrieval

For coding tasks, retrieve current repository evidence independently of
conversational memory. Historical claims can be stale. Current code,
configuration, branch and build state should be checked where relevant.

### Stage 5 --- Ranking, deduplication and assembly

-   Enforce authorization filters before semantic ranking.
-   Rank by relevance, importance, freshness and confidence.
-   Prefer current authoritative facts over stale assumptions.
-   Deduplicate overlapping summaries and memories.
-   Fit the selected material into the context budget.
-   Preserve source references and exclusions in the context manifest.

Suggested ranking formula:

``` text
Score = wr * Relevance
      + wi * Importance
      + wf * Freshness
      + wc * Confidence
      + wa * Authority
```

Weights should be tuned using evaluation data. Do not use this score as
a substitute for access control or explicit authority rules.

------------------------------------------------------------------------

## 9. Context package contract

The Agent Runtime should request a context package for each LLM
invocation. It should not independently implement history and memory
retrieval.

Illustrative logical contract:

``` json
{
  "contextId": "ctx-001",
  "conversationId": "conv-001",
  "executionId": "exec-001",
  "agentId": "agent-001",
  "contextVersion": 12,
  "sections": {
    "systemInstructions": {},
    "currentRequest": {},
    "recentConversation": [],
    "conversationMemory": [],
    "projectMemory": [],
    "executionState": {},
    "repositoryContext": [],
    "historicalReferences": []
  },
  "budget": {
    "maximumTokens": 64000,
    "allocatedTokens": 52000,
    "reservedOutputTokens": 12000
  },
  "retrievalMetadata": {
    "segmentsRetrieved": 3,
    "memoriesRetrieved": 8,
    "memoriesExcluded": 12,
    "truncated": false
  }
}
```

In production, large content can be represented by references and typed
objects rather than embedding every artifact in the response.

### Context manifest

Persist a manifest for each LLM invocation, recording: - Included
message IDs and segment IDs. - Included memory IDs and versions. -
Summary versions used. - Repository references and versions where
available. - Token allocation and actual token count. - Excluded
candidates and exclusion reasons. - Retrieval policy/version. - Model
and tokenizer identifiers.

This supports debugging, quality evaluation and reproducibility.

The context package should be a versioned snapshot. If the conversation
changes during a long execution, the runtime should know whether its
context is stale and whether a new user instruction must be
incorporated.

------------------------------------------------------------------------

## 10. Token and infrastructure budget management

The Context Budget Manager should consider: 1. Model context capacity.
2. Output token reservation. 3. Tool schema and instruction overhead. 4.
Task complexity. 5. Infrastructure and retrieval latency. 6. Available
retrieval and execution quotas.

Illustrative 128K-token budget:

  Context component                   Allocation
  --------------------------------- ------------
  System instructions and tools               8K
  Current conversation                       12K
  Historical segments                        12K
  Conversation and project memory            12K
  Repository context                         32K
  Execution state                             8K
  Output and safety reserve                  44K
  **Total**                             **128K**

These are ceilings, not fixed reservations. Unused capacity can be
redistributed. The actual model limit and tokenizer must be
authoritative.

### Task-sensitive profiles

  -----------------------------------------------------------------------
  Execution type                      Retrieval emphasis
  ----------------------------------- -----------------------------------
  Simple code change                  Current task and small history
                                      window

  Complex refactoring                 Repository and architectural
                                      context

  Bug investigation                   Historical executions, logs and
                                      tool evidence

  New project feature                 Project memory and repository
                                      context

  Return after long inactivity        Historical reconstruction and
                                      current repository state
  -----------------------------------------------------------------------

### Infrastructure-aware behaviour

  -----------------------------------------------------------------------
  Condition                           Behaviour
  ----------------------------------- -----------------------------------
  Normal                              Full retrieval and ranking

  High cache pressure                 Reduce cached working set; retain
                                      durable data

  High vector search latency          Prefer indexed metadata and cached
                                      summaries

  High storage pressure               Archive eligible artifacts and logs

  High context pressure               Compact or defer low-priority
                                      context

  High execution concurrency          Enforce per-execution retrieval
                                      quotas
  -----------------------------------------------------------------------

Reducing LLM context size and reducing database storage are separate
operations. Storage pressure must not silently delete useful history.

------------------------------------------------------------------------

## 11. Compaction and archival workflow

Compaction should run asynchronously for completed segments.

### Compaction steps

1.  Identify eligible completed segments.
2.  Extract topics, entities, decisions, constraints and outcomes.
3.  Generate a concise segment summary.
4.  Preserve source message references.
5.  Create or update memory candidates.
6.  Deduplicate and validate candidates.
7.  Commit the summary and memory updates atomically or through a
    recoverable workflow.
8.  Mark the segment compacted.
9.  Archive eligible raw data and large artifacts according to policy.

### Example

Original discussion: - User requests Redis caching. - TTL is agreed as
15 minutes. - Cache invalidation on customer updates is required. -
Customer updates must not depend on TTL expiration.

Compacted structured summary:

``` json
{
  "topic": "Customer API caching",
  "decisions": [
    {
      "decision": "Use Redis distributed cache",
      "sourceMessageIds": ["msg-101"]
    },
    {
      "decision": "Default TTL is 15 minutes",
      "sourceMessageIds": ["msg-104"]
    },
    {
      "decision": "Invalidate cache on customer updates",
      "sourceMessageIds": ["msg-106"]
    }
  ],
  "constraints": [
    "Customer updates must not depend on TTL expiration"
  ],
  "status": "approved",
  "sourceMessageRange": {
    "from": "msg-101",
    "to": "msg-108"
  }
}
```

Never delete or replace the original segment until its summary and
required memory updates have been successfully committed. Compaction
must be versioned and recoverable.

------------------------------------------------------------------------

## 12. Execution continuity and checkpointing

Execution state is separate from conversation history and memory.

Persist: - Execution status and current task. - Plan and task
dependencies. - Agent and child-agent statuses. - Tool operation
identifiers and outcomes. - Repository branch and commit. - Working-tree
state or patch references. - Artifact references. - Current context
references and checkpoint version. - Pending operations requiring
reconciliation.

### Event sourcing

Record meaningful execution events, for example:

``` text
SessionCreated
ExecutionStarted
PlanGenerated
RepositoryAnalysed
FileRead
CodeModified
ValidationStarted
ValidationCompleted
UnitTestStarted
UnitTestFailed
CheckpointCreated
ExecutionInterrupted
ExecutionResumed
ExecutionCompleted
```

The current execution state can be projected from the event stream.

Use idempotency keys for tool operations and reconcile external side
effects on recovery. Do not blindly replay events that might repeat a
deployment, commit, payment or other external action.

### Recovery sequence

``` text
Execution Interrupted
       |
       v
Load Latest Checkpoint
       |
       v
Reconstruct Execution State
       |
       v
Verify Workspace / Git State
       |
       v
Reconcile Incomplete Tool Calls
       |
       v
Rebuild Agent Context
       |
       v
Resume Pending Task
```

Prefer logical checkpoints containing state, patches and artifact
references. VM snapshots may be an optional optimization, not the
foundation of durability.

------------------------------------------------------------------------

## 13. Multi-agent context sharing

Agents should have isolated working contexts while sharing authorized
project knowledge and execution references.

``` mermaid
flowchart TB
    P[Parent Agent / Orchestrator]
    PM[(Shared Project Memory)]
    BUS[Execution Event Bus]

    P --> A[Architecture Agent]
    P --> B[Implementation Agent]
    P --> C[Test Agent]
    P --> D[Review Agent]

    PM <--> A
    PM <--> B
    PM <--> C
    PM <--> D

    A <--> BUS
    B <--> BUS
    C <--> BUS
    D <--> BUS

    A --> P
    B --> P
    C --> P
    D --> P
```

Each child agent receives: 1. Parent task description. 2. Relevant
project memory. 3. Its specific responsibilities. 4. Required
dependencies and artifacts. 5. Explicit output contract. 6. Access
permissions and workspace boundaries.

Each agent maintains its own task history, tool results and checkpoints.
It returns a structured result to the parent.

Context isolation alone does not prevent code conflicts. Use workspace
isolation, file ownership, branch/patch coordination or controlled merge
operations.

------------------------------------------------------------------------

## 14. Data model and database boundaries

Recommended logical modules or PostgreSQL schemas:

  -----------------------------------------------------------------------
  Schema/module                       Tables
  ----------------------------------- -----------------------------------
  `conversation`                      conversations, messages, segments,
                                      segment_summaries

  `execution`                         executions, tasks,
                                      execution_events, checkpoints

  `memory`                            memories, memory_versions,
                                      memory_sources, memory_embeddings

  `platform`                          workspaces, projects,
                                      retention_policies,
                                      context_manifests

  `artifact`                          artifact metadata and storage
                                      references
  -----------------------------------------------------------------------

### Core entities

  Entity                Purpose
  --------------------- ----------------------------------------
  Conversation          Long-lived user conversation
  Message               Individual user/agent message
  ConversationSegment   Rolling and compaction boundary
  SegmentSummary        Compressed historical context
  Execution             Individual agent execution
  Task                  Planned work and dependencies
  ExecutionEvent        Append-only execution history
  Checkpoint            Resumable execution snapshot
  Memory                Persistent knowledge
  MemoryVersion         Historical version and supersession
  MemorySource          Provenance references
  ContextManifest       Record of assembled context
  Artifact              Files, logs, patches and large outputs

### Suggested implementation details

-   PostgreSQL is the source of truth.
-   Use JSONB for extensible metadata, not as a substitute for all
    relational structure.
-   Use pgvector for selected summaries and memory records.
-   Use Redis only for disposable active-state and retrieval caches.
-   Use object storage for large logs, patches, files and archived
    content.
-   Use an event bus for asynchronous compaction and memory extraction.
-   Use database transactions or transactional outbox patterns for
    reliable event publication.

------------------------------------------------------------------------

## 15. API boundaries

Suggested initial API surface:

  Method   Endpoint                         Purpose
  -------- -------------------------------- ---------------------------------
  POST     `/conversations`                 Create conversation
  GET      `/conversations/{id}`            Retrieve conversation metadata
  POST     `/conversations/{id}/messages`   Persist message
  GET      `/conversations/{id}/history`    Retrieve paginated history
  POST     `/context/assemble`              Construct LLM context
  POST     `/context/retrieve`              Retrieve historical information
  POST     `/memory/extract`                Generate memory candidates
  POST     `/memory/promote`                Promote validated memories
  GET      `/memory/search`                 Search authorized memory
  POST     `/executions`                    Create execution
  POST     `/executions/{id}/checkpoint`    Persist checkpoint
  POST     `/executions/{id}/resume`        Resume execution

### Agent Runtime interaction

``` text
Agent Runtime
     |
     | Request context for conversation/execution/task
     v
Context Management API
     |
     | Assembled, versioned context package
     v
Agent Runtime
     |
     | Execution events and tool outcomes
     v
Durable Event Persistence
     |
     | Async events
     v
Memory / Compaction Workers
```

The runtime should not need to understand how conversation history is
stored, how vector retrieval works or how compaction is performed.

------------------------------------------------------------------------

## 16. Technology recommendations

  -----------------------------------------------------------------------
  Capability              Initial recommendation  Rationale
  ----------------------- ----------------------- -----------------------
  Primary database        PostgreSQL              Conversations,
                                                  messages, execution
                                                  state and memory
                                                  metadata

  Vector retrieval        pgvector                Semantic retrieval
                                                  without another
                                                  database initially

  Cache                   Redis                   Active context and
                                                  session cache

  Artifact storage        S3 / Azure Blob         Large outputs, logs,
                                                  archives and patches

  Event processing        Existing event bus or   Async compaction and
                          Kafka                   memory extraction

  Keyword search          PostgreSQL full-text    Initial lexical
                          search                  retrieval

  Embeddings              Configurable provider   Avoid model lock-in

  Agent runtime           Existing Kronyx runtime Keep execution separate
                          / SDK integration       from context management
  -----------------------------------------------------------------------

Do not introduce Elasticsearch, a dedicated vector database or a complex
distributed memory platform until measured scale or retrieval quality
justifies it.

------------------------------------------------------------------------

## 17. Security, consistency and correctness

### Tenant and project isolation

Every retrieval must enforce: - Workspace authorization. - Project
membership. - Conversation ownership. - Agent permissions. - Memory
classification and sensitivity.

Authorization filters must be applied before semantic ranking. Vector
similarity is never an access-control mechanism.

### Untrusted content

Historical messages, retrieved documents, code and tool outputs are
data, not system instructions. They must not override current platform
policies or agent permissions.

### Concurrent updates

Use: - Optimistic concurrency and version checks for memory records. -
Append-only events for execution history. - Idempotency keys for tool
operations. - Transactional outbox for reliable event publication. -
Explicit conflict resolution for competing memory updates.

### Memory conflicts

Represent supersession and temporal validity. Do not silently choose
between conflicting facts based only on semantic similarity.

### Deletion and retention

Retention and deletion policies must cover raw messages, summaries,
embeddings, memory sources, artifacts and caches. Deletion workflows
should propagate to derived data and cold storage, subject to applicable
legal and organizational requirements.

------------------------------------------------------------------------

## 18. Observability and quality metrics

Measure the quality and cost of context management, not just response
latency.

  Metric                            Purpose
  --------------------------------- -----------------------
  Context reconstruction latency    User experience
  Context tokens per execution      LLM cost
  Historical retrieval precision    Relevance
  Memory promotion accuracy         Knowledge quality
  Context truncation rate           Capacity planning
  Resume success rate               Execution reliability
  Stale memory retrieval rate       Correctness
  Duplicate memory ratio            Storage efficiency
  Retrieval miss rate               Context continuity
  Compaction success/failure rate   Lifecycle reliability
  Archive retrieval latency         Cold-tier performance
  Context manifest coverage         Debuggability

Every LLM invocation should be traceable to its context manifest.

------------------------------------------------------------------------

## 19. Initial rolling and retention policy

The following are starting defaults for evaluation, not immutable
limits.

  Parameter                  Initial policy
  -------------------------- -----------------------------------------------
  Active message window      Last 20--30 messages, subject to token budget
  Active context             Configurable by model and task
  Compaction trigger         70--80% of configured active context budget
  Historical retrieval       Top 5--10 relevant segments
  Project memory retrieval   Top 10--20 relevant records
  Session state              Persist on significant transitions
  Checkpointing              At task boundaries and critical operations
  Raw conversation           Durable, subject to configured retention
  Large tool outputs         Object storage with references
  Cache                      Disposable and reconstructable

Use token volume rather than message count as the actual rolling
threshold. A small number of code-heavy messages can consume more tokens
than many short messages.

------------------------------------------------------------------------

## 20. Implementation roadmap

### Milestone 1 --- Persistent conversations

-   Conversation and message storage.
-   Conversation/execution separation.
-   Segment management.
-   Active and archived storage states.
-   Redis context cache.
-   Basic checkpointing.

**Acceptance outcome:** Users can return to an old conversation and
continue it after runtime replacement or inactivity.

### Milestone 2 --- Rolling context engine

-   Context Builder.
-   Token budget manager.
-   Segment summaries.
-   Historical retrieval.
-   Context manifests.
-   Asynchronous compaction workers.

**Acceptance outcome:** Long conversations remain usable without loading
their entire history.

### Milestone 3 --- Hybrid memory

-   Conversation memory.
-   Project memory.
-   Memory candidate extraction.
-   Provenance and confidence.
-   Deduplication and conflict detection.
-   Promotion and supersession.
-   Semantic retrieval.

**Acceptance outcome:** Validated knowledge carries across conversations
and executions.

### Milestone 4 --- Intelligent optimization

-   Adaptive context budgets.
-   Retrieval ranking.
-   Memory lifecycle policies.
-   Infrastructure-aware compaction.
-   Multi-agent memory coordination.
-   Retrieval quality evaluation.

**Acceptance outcome:** Context management becomes an intelligent,
measurable platform capability.

------------------------------------------------------------------------

## 21. Context simulator and test strategy

Before production rollout, build a simulator that can test: -
1,000-message conversations. - Conversations spanning 30--90 days. -
Multiple executions in one conversation. - Multiple conversations
sharing project memory. - Context budget exhaustion. - Missing, stale or
contradictory memories. - Interrupted execution and recovery. -
Concurrent agents updating shared knowledge. - Archive and restore
behaviour. - Retention and deletion propagation.

For each simulated LLM invocation, capture the assembled context
manifest without requiring an actual LLM call.

Evaluate: - Whether required decisions were retrieved. - Whether
irrelevant history was excluded. - Whether stale facts were detected. -
Whether the context fit the budget. - Whether source provenance was
preserved. - Whether recovery reconstructed the correct execution state.

------------------------------------------------------------------------

## 22. Key architectural decisions to preserve

1.  **Conversation Store is the source of truth** for conversation
    history.
2.  **Memory Store is the knowledge layer** for validated, reusable
    information.
3.  **Execution Store is the source of truth** for agent progress and
    recovery.
4.  **Context Builder is the intelligence layer** that assembles
    model-ready context.
5.  **Rolling context is not data deletion.** Retrieval and retention
    are separate policies.
6.  **Conversation memory is isolated; project memory is shared**
    subject to authorization.
7.  **Memory promotion is controlled.** Extraction does not
    automatically imply authority.
8.  **Agent runtime is disposable.** Durable state must survive
    independently.
9.  **Every assembled context is observable** through a versioned
    manifest.
10. **The system is model- and SDK-independent.**

## 23. Final recommendation

Kronyx should be built around three independent but interconnected
capabilities:

-   **Conversation Continuity:** Retains conversation identity and
    history across days and executions.
-   **Knowledge Continuity:** Maintains validated, reusable knowledge at
    conversation and project scope.
-   **Execution Continuity:** Preserves task progress, agent state,
    artifacts and checkpoints independently of the runtime.

The Context Management Engine orchestrates these capabilities to
construct the right context for every agent invocation.

This provides a scalable foundation for persistent agentic conversations
without requiring unlimited infrastructure capacity. It also allows
Kronyx to evolve across different agent SDKs, LLM providers, execution
environments and multi-agent orchestration strategies without
redesigning its memory architecture.

------------------------------------------------------------------------

## Appendix A --- Recommended first implementation scope

Build the following first:

1.  PostgreSQL conversation, message, segment, execution and checkpoint
    models.
2.  Conversation activation and message persistence APIs.
3.  A Context Builder that loads recent messages, current execution
    state and pinned project knowledge.
4.  Token counting and configurable context budgets.
5.  A simple rolling compaction worker.
6.  Context manifests for every LLM invocation.
7.  Redis as an optional cache, never as the source of truth.

Then introduce semantic retrieval and automated memory promotion after
the basic conversation continuity and recovery flows are reliable.

## Appendix B --- Open implementation decisions

These require product and engineering validation before production
defaults are fixed:

-   Exact raw conversation retention periods by workspace plan.
-   Whether archived history is synchronously or asynchronously
    retrievable.
-   Model-specific token budget profiles.
-   Embedding model and migration strategy.
-   Memory confidence thresholds and approval rules.
-   Project memory access and sharing controls.
-   Whether workspace-level memory is included in the first release.
-   Cold storage provider and retrieval service-level objectives.
-   Data residency, encryption, deletion and audit requirements.
-   Expected concurrent conversations, executions and agents per
    workspace.
