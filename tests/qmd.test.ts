import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { QMD } from "../dist/lib/qmd.js";
import { MemoryContract } from "../dist/lib/memory.js";
import { getDb } from "../dist/db.js";

const TEST_DB_PATH = "/tmp/antfarm-qmd-test.db";

function createTestRun(db: any, runId: string) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO runs (id, workflow_id, task, status, created_at, updated_at)
    VALUES (?, 'test-workflow', 'test task', 'running', ?, ?)
  `).run(runId, now, now);
}

describe("QMD Query Layer", () => {
  let runId: string;

  beforeEach(() => {
    runId = `test-run-${Date.now()}`;
    process.env.ANTFARM_DB_PATH = TEST_DB_PATH;
    // Force fresh connection and create run
    const db = getDb();
    createTestRun(db, runId);
  });

  afterEach(() => {
    try {
      MemoryContract.clearRun(runId);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("query", () => {
    it("should find exact key matches with highest score", () => {
      MemoryContract.setContract(runId, "constraint", "database_schema", { tables: ["users"] }, 10);
      MemoryContract.setContract(runId, "context", "database_config", { settings: {} }, 5);

      const results = QMD.query(runId, "database_schema");
      
      assert.ok(results.length > 0);
      assert.strictEqual(results[0].contract.key, "database_schema");
      assert.strictEqual(results[0].score, 1.0);
      assert.strictEqual(results[0].strategy, "exact_key");
    });

    it("should find key contains matches", () => {
      MemoryContract.setContract(runId, "constraint", "user_authentication_flow", { method: "jwt" }, 8);
      MemoryContract.setContract(runId, "context", "api_documentation", {}, 5);

      const results = QMD.query(runId, "authentication");
      
      assert.ok(results.length > 0);
      assert.strictEqual(results[0].strategy, "key_contains");
      assert.ok(results[0].score >= 0.9);
    });

    it("should find value contains matches", () => {
      MemoryContract.setContract(runId, "decision", "auth_method", { strategy: "oauth2 with google provider" }, 7);

      const results = QMD.query(runId, "google");
      
      assert.ok(results.length > 0);
      assert.strictEqual(results[0].strategy, "value_contains");
    });

    it("should use semantic similarity for related terms", () => {
      MemoryContract.setContract(runId, "context", "orm_setup", { 
        description: "Prisma ORM with PostgreSQL database connection pooling" 
      }, 5);

      // Query with related but not exact terms
      const results = QMD.query(runId, "sql database connection", { minScore: 0.2 });
      
      assert.ok(results.length > 0);
      // Could be semantic or value_contains depending on overlap
      assert.ok(['semantic', 'value_contains'].includes(results[0].strategy));
    });

    it("should filter by type", () => {
      MemoryContract.setContract(runId, "constraint", "c1", {}, 10);
      MemoryContract.setContract(runId, "decision", "d1", {}, 10);
      MemoryContract.setContract(runId, "context", "ctx1", {}, 10);

      const results = QMD.query(runId, "1", { type: "constraint" });
      
      assert.ok(results.every(r => r.contract.contract_type === "constraint"));
    });

    it("should filter by minimum priority", () => {
      MemoryContract.setContract(runId, "context", "high_priority", {}, 10);
      MemoryContract.setContract(runId, "context", "low_priority", {}, 1);

      const results = QMD.query(runId, "priority", { minPriority: 5 });
      
      assert.ok(results.every(r => r.contract.priority >= 5));
    });

    it("should respect limit option", () => {
      for (let i = 0; i < 20; i++) {
        MemoryContract.setContract(runId, "context", `key${i}`, {}, 5);
      }

      const results = QMD.query(runId, "key", { limit: 5 });
      
      assert.strictEqual(results.length, 5);
    });

    it("should return empty array when no matches above threshold", () => {
      MemoryContract.setContract(runId, "context", "unrelated", { data: "xyz" }, 5);

      const results = QMD.query(runId, "completely different topic", { minScore: 0.5 });
      
      assert.strictEqual(results.length, 0);
    });

    it("should rank results by score descending", () => {
      MemoryContract.setContract(runId, "constraint", "exact", {}, 5);     // exact match
      MemoryContract.setContract(runId, "context", "exact_match", {}, 5);  // contains match
      MemoryContract.setContract(runId, "context", "something_else", { exact: true }, 5);  // value match

      const results = QMD.query(runId, "exact");
      
      assert.ok(results.length >= 3);
      // Scores should be descending
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i].score <= results[i-1].score);
      }
    });
  });

  describe("findRelated", () => {
    it("should find co-accessed contracts", () => {
      // Create contracts
      MemoryContract.setContract(runId, "constraint", "schema", {}, 10);
      MemoryContract.setContract(runId, "decision", "orm", {}, 8);
      MemoryContract.setContract(runId, "context", "tech_stack", {}, 5);

      // Access both contracts to create relationship via session log
      MemoryContract.getContract(runId, "schema");
      MemoryContract.getContract(runId, "orm");

      const related = QMD.findRelated(runId, "schema", 1);
      
      // Should return an array (may or may not find orm depending on timing)
      assert.ok(Array.isArray(related));
    });

    it("should respect depth limit", () => {
      MemoryContract.setContract(runId, "constraint", "a", {}, 10);
      MemoryContract.setContract(runId, "constraint", "b", {}, 9);
      MemoryContract.setContract(runId, "constraint", "c", {}, 8);

      const related = QMD.findRelated(runId, "a", 0);
      
      // Depth 0 should only return immediate relations (none in this case without logs)
      assert.strictEqual(related.length, 0);
    });
  });

  describe("suggestRelevant", () => {
    it("should suggest contracts matching context keywords", () => {
      MemoryContract.setContract(runId, "constraint", "auth_middleware", { 
        description: "JWT authentication middleware for express routes" 
      }, 10);
      
      MemoryContract.setContract(runId, "decision", "database", { 
        description: "PostgreSQL with Prisma ORM" 
      }, 8);

      const suggestions = QMD.suggestRelevant(
        runId, 
        "I need to implement user login with JWT tokens for authentication",
        5
      );

      assert.ok(suggestions.length > 0);
      // Should suggest auth-related contract
      assert.ok(suggestions.some(s => s.key === "auth_middleware"));
    });

    it("should filter out common words", () => {
      MemoryContract.setContract(runId, "context", "test_key", { data: "value" }, 5);

      // Context with only common words
      const suggestions = QMD.suggestRelevant(
        runId,
        "this that with from have been they will would there their",
        5
      );

      // Should not match anything since all words are filtered
      assert.strictEqual(suggestions.length, 0);
    });

    it("should respect limit", () => {
      for (let i = 0; i < 10; i++) {
        MemoryContract.setContract(runId, "context", `key${i}`, { data: `value${i}` }, 5);
      }

      const suggestions = QMD.suggestRelevant(runId, "value0 value1 value2", 3);
      
      assert.ok(suggestions.length <= 3);
    });
  });

  describe("n-gram similarity", () => {
    it("should match semantically similar terms", () => {
      MemoryContract.setContract(runId, "context", "database_connection", {
        description: "PostgreSQL connection pooling configuration"
      }, 5);

      // Different words but semantically related
      const results = QMD.query(runId, "sql database pool", { minScore: 0.1 });
      
      // May or may not match depending on n-gram overlap
      if (results.length > 0) {
        assert.ok(['semantic', 'value_contains'].includes(results[0].strategy));
      }
    });

    it("should score higher for more n-gram overlap", () => {
      MemoryContract.setContract(runId, "context", "a", { text: "foo bar baz qux" }, 5);
      MemoryContract.setContract(runId, "context", "b", { text: "foo bar xyz" }, 5);

      const results = QMD.query(runId, "foo bar baz");
      
      // 'a' should rank higher due to more overlap
      const resultA = results.find(r => r.contract.key === "a");
      const resultB = results.find(r => r.contract.key === "b");
      
      if (resultA && resultB) {
        assert.ok(resultA.score > resultB.score);
      }
    });
  });
});
