# Memory System

Antfarm's memory system prevents the three failure modes of long-running agent workflows: missed writes, missed retrieval, and compaction loss. It provides explicit memory contracts, working set control, checkpoint persistence, and semantic search.

---

## Overview

When agents run in fresh sessions (the Ralph pattern), they lose access to previous context. The memory system solves this by:

1. **Explicit Memory Contracts** - Structured persistence for constraints, decisions, context, and checkpoints
2. **Working Set Control** - LRU eviction with priority boosting prevents unbounded growth
3. **Checkpoint System** - Automatic save/restore of workflow state
4. **QMD Query Layer** - Semantic search with ranked results

---

## Memory Contract Types

### Constraint
Hard rules that must be respected by all future steps.

```typescript
MemoryContract.setContract(
  runId,
  'constraint',
  'database_schema',
  { tables: ['users', 'posts'], orm: 'prisma' },
  10  // high priority
);
```

### Decision
Recorded decisions that future steps should know about.

```typescript
MemoryContract.setContract(
  runId,
  'decision',
  'auth_strategy',
  { method: 'jwt', library: 'auth.js' },
  8
);
```

### Context
General information about the codebase or task.

```typescript
MemoryContract.setContract(
  runId,
  'context',
  'tech_stack',
  { frontend: 'react', backend: 'express', db: 'postgresql' },
  5
);
```

### Checkpoint
Workflow state for resumption after interruption.

```typescript
MemoryContract.createCheckpoint(runId, stepId, {
  completedStories: ['story-1', 'story-2'],
  currentStory: 'story-3',
  branch: 'feature/auth'
});
```

---

## Working Set Control

Each run has a maximum working set size (default: 100 contracts). When exceeded, lowest-priority oldest contracts are evicted.

### Priority Levels

| Priority | Use Case |
|----------|----------|
| 10 | Critical constraints (schema, API contracts) |
| 8-9 | Important decisions (architecture, libraries) |
| 5-7 | Context (tech stack, conventions) |
| 1-4 | Temporary data, low-priority context |

### Access Tracking

Contracts track access count and last accessed time. Frequently accessed contracts get priority boosts in the working set.

```typescript
// Get working set with LRU + priority boosting
const workingSet = MemoryContract.getWorkingSet(runId, 20);
```

---

## Checkpoint System

Checkpoints automatically save on step completion and restore on step claim.

### Auto-Save

When a step completes, the workflow runner creates a checkpoint with:
- Current step ID
- Completed stories
- In-progress story
- Branch name
- Any step-specific state

### Auto-Restore

When claiming a step, the runner checks for checkpoints:

```typescript
const checkpoint = MemoryContract.getLatestCheckpoint(runId);
if (checkpoint) {
  // Resume from checkpoint
}
```

### Retention

Only the last 10 checkpoints per run are kept. Older checkpoints are pruned automatically.

---

## QMD Query Layer

The Query-Model-Data layer provides semantic search over memory contracts.

### Search Strategies

1. **Exact Key Match** - Score 1.0
2. **Key Contains Query** - Score 0.9
3. **Value Contains Query** - Score 0.7
4. **N-gram Semantic Similarity** - Score 0.5-0.8

### Usage

```typescript
import { QMD } from './lib/qmd.js';

// Search with semantic ranking
const results = QMD.query(runId, 'authentication', {
  type: 'constraint',
  minPriority: 5,
  limit: 10,
  minScore: 0.3
});

// Find related contracts
const related = QMD.findRelated(runId, 'auth_strategy', 2);

// Get suggestions based on context
const suggestions = QMD.suggestRelevant(runId, 'implementing user login', 5);
```

---

## CLI Commands

The memory CLI provides debugging and management tools:

```bash
# List all contracts for a run
antfarm memory list <run-id>

# Get a specific contract
antfarm memory get <run-id> <key>

# Search by keyword
antfarm memory search <run-id> <keyword>

# QMD semantic search
antfarm memory query <run-id> <query>

# Show session operation log
antfarm memory log <run-id>

# Show latest checkpoint
antfarm memory checkpoint <run-id>

# Clear all memory for a run
antfarm memory clear <run-id>
```

---

## Workflow Integration

### Template Variables

Workflow steps automatically receive memory context:

```yaml
input: |
  REQUIRED_MEMORY_SEARCH:
  Working Set: {{memory_working_set}}
  Constraints: {{memory_constraints}}
  Decisions: {{memory_decisions}}
  Checkpoint: {{checkpoint_step}}
```

### Agent Acknowledgment

Agents must acknowledge constraints before proceeding:

```
MEMORY_ACKNOWLEDGED: database_schema (prisma), auth_strategy (jwt)
```

This forced acknowledgment prevents agents from ignoring critical constraints.

---

## Migration Guide

### Existing Workflows

To add memory support to an existing workflow:

1. **Add REQUIRED_MEMORY_SEARCH section** to each step template:

```yaml
input: |
  REQUIRED_MEMORY_SEARCH:
  Working Set: {{memory_working_set}}
  Constraints: {{memory_constraints}}
  Decisions: {{memory_decisions}}
  Checkpoint: {{checkpoint_step}}

  MEMORY_ACKNOWLEDGED: (list which constraints/decisions you considered)
```

2. **Add memory acknowledgment requirement** to instructions:

```yaml
Instructions:
1. Review memory constraints and decisions above
2. Acknowledge key constraints in MEMORY_ACKNOWLEDGED
3. ... rest of instructions
```

3. **Use key_decision and key_constraint outputs**:

Agents should output decisions/constraints for future steps:

```
STATUS: done
key_decision: Using zod for validation (affects all future API contracts)
key_constraint: Database schema uses camelCase columns
```

### Database Migration

The memory tables are created automatically on first use. No manual migration needed.

---

## Best Practices

1. **Set high priorities for constraints** - Schema changes, API contracts
2. **Record decisions immediately** - Don't wait, write while context is fresh
3. **Use descriptive keys** - `auth_strategy` not `decision_1`
4. **Keep values structured** - JSON objects, not prose
5. **Acknowledge in outputs** - Always list what constraints were considered
6. **Query before assuming** - Use QMD to find related context

---

## Troubleshooting

### Contracts Not Found

Check the session log:

```bash
antfarm memory log <run-id>
```

Look for `read` operations with `✗` status.

### Working Set Too Small

Increase the limit:

```typescript
const contracts = MemoryContract.getAllForRun(runId, 200);
```

### Checkpoints Not Restoring

Verify checkpoint exists:

```bash
antfarm memory checkpoint <run-id>
```

Check that the workflow runner is calling `getLatestCheckpoint` on step claim.

---

## API Reference

### MemoryContract

| Method | Description |
|--------|-------------|
| `setContract(runId, type, key, value, priority?)` | Create or update a contract |
| `getContract(runId, key)` | Retrieve a contract by key |
| `searchContracts(runId, type)` | Get all contracts of a type |
| `getAllForRun(runId, limit?)` | Get all contracts for a run |
| `getByPriority(runId, minPriority)` | Filter by priority threshold |
| `searchByKeyword(runId, keyword)` | Substring search |
| `getWorkingSet(runId, maxSize?)` | LRU + priority ranked contracts |
| `createCheckpoint(runId, stepId, data)` | Save checkpoint |
| `getLatestCheckpoint(runId)` | Get most recent checkpoint |
| `clearRun(runId)` | Delete all data for a run |
| `getSessionLog(runId, limit?)` | Get operation audit log |

### QMD

| Method | Description |
|--------|-------------|
| `query(runId, query, options?)` | Semantic search with ranking |
| `findRelated(runId, key, depth?)` | Graph traversal for related contracts |
| `suggestRelevant(runId, context, limit?)` | Context-based suggestions |

---

*Part of the Antfarm workflow system. See [creating-workflows.md](./creating-workflows.md) for workflow authoring.*
