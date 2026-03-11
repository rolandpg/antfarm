import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryContract } from "../dist/lib/memory.js";
import { getDb } from "../dist/db.js";

// Test database path
const TEST_DB_PATH = "/tmp/antfarm-memory-test.db";

function createTestRun(db: any, runId: string) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO runs (id, workflow_id, task, status, created_at, updated_at)
    VALUES (?, 'test-workflow', 'test task', 'running', ?, ?)
  `).run(runId, now, now);
}

describe("MemoryContract", () => {
  let runId: string;

  beforeEach(() => {
    runId = `test-run-${Date.now()}`;
    // Use test database
    process.env.ANTFARM_DB_PATH = TEST_DB_PATH;
    // Force fresh connection and create run
    const db = getDb();
    createTestRun(db, runId);
  });

  afterEach(() => {
    // Clean up
    try {
      const db = getDb();
      db.prepare("DELETE FROM memory_contracts WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM memory_checkpoints WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM session_index WHERE run_id = ?").run(runId);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("setContract / getContract", () => {
    it("should create and retrieve a contract", () => {
      const id = MemoryContract.setContract(
        runId,
        "constraint",
        "test_key",
        { foo: "bar" },
        8
      );

      assert.ok(id);
      assert.strictEqual(id.length, 36); // UUID length

      const contract = MemoryContract.getContract(runId, "test_key");
      assert.ok(contract);
      assert.strictEqual(contract.contract_type, "constraint");
      assert.strictEqual(contract.key, "test_key");
      assert.deepStrictEqual(contract.value, { foo: "bar" });
      assert.strictEqual(contract.priority, 8);
    });

    it("should update existing contract on conflict", () => {
      MemoryContract.setContract(runId, "context", "same_key", { v: 1 }, 5);
      MemoryContract.setContract(runId, "constraint", "same_key", { v: 2 }, 10);

      const contract = MemoryContract.getContract(runId, "same_key");
      assert.strictEqual(contract?.contract_type, "constraint");
      assert.deepStrictEqual(contract?.value, { v: 2 });
      assert.strictEqual(contract?.priority, 10);
    });

    it("should return null for non-existent key", () => {
      const contract = MemoryContract.getContract(runId, "does_not_exist");
      assert.strictEqual(contract, null);
    });

    it("should track access count", () => {
      MemoryContract.setContract(runId, "context", "tracked_key", { data: true });
      
      MemoryContract.getContract(runId, "tracked_key");
      MemoryContract.getContract(runId, "tracked_key");
      
      const contract = MemoryContract.getContract(runId, "tracked_key");
      assert.ok(contract?.access_count >= 2);
    });
  });

  describe("searchContracts", () => {
    it("should filter by type", () => {
      MemoryContract.setContract(runId, "constraint", "c1", {}, 10);
      MemoryContract.setContract(runId, "constraint", "c2", {}, 9);
      MemoryContract.setContract(runId, "decision", "d1", {}, 8);
      MemoryContract.setContract(runId, "context", "ctx1", {}, 5);

      const constraints = MemoryContract.searchContracts(runId, "constraint");
      assert.strictEqual(constraints.length, 2);
      assert.ok(constraints.every(c => c.contract_type === "constraint"));
    });

    it("should sort by priority desc, then created desc", () => {
      MemoryContract.setContract(runId, "context", "low", {}, 1);
      MemoryContract.setContract(runId, "context", "high", {}, 10);
      MemoryContract.setContract(runId, "context", "med", {}, 5);

      const results = MemoryContract.searchContracts(runId, "context");
      assert.strictEqual(results[0].key, "high");
      assert.strictEqual(results[1].key, "med");
      assert.strictEqual(results[2].key, "low");
    });
  });

  describe("getAllForRun", () => {
    it("should return all contracts for a run", () => {
      MemoryContract.setContract(runId, "constraint", "k1", {}, 10);
      MemoryContract.setContract(runId, "decision", "k2", {}, 5);
      MemoryContract.setContract(runId, "context", "k3", {}, 1);

      const all = MemoryContract.getAllForRun(runId);
      assert.strictEqual(all.length, 3);
    });

    it("should respect limit", () => {
      for (let i = 0; i < 10; i++) {
        MemoryContract.setContract(runId, "context", `key${i}`, {}, 5);
      }

      const limited = MemoryContract.getAllForRun(runId, 5);
      assert.strictEqual(limited.length, 5);
    });
  });

  describe("getByPriority", () => {
    it("should filter by minimum priority", () => {
      MemoryContract.setContract(runId, "context", "high", {}, 10);
      MemoryContract.setContract(runId, "context", "med", {}, 5);
      MemoryContract.setContract(runId, "context", "low", {}, 1);

      const highOnly = MemoryContract.getByPriority(runId, 8);
      assert.strictEqual(highOnly.length, 1);
      assert.strictEqual(highOnly[0].key, "high");
    });
  });

  describe("searchByKeyword", () => {
    it("should find contracts by key substring", () => {
      MemoryContract.setContract(runId, "context", "user_auth_config", { data: "x" });
      MemoryContract.setContract(runId, "context", "database_schema", { data: "y" });
      MemoryContract.setContract(runId, "context", "api_endpoints", { data: "z" });

      const results = MemoryContract.searchByKeyword(runId, "auth");
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, "user_auth_config");
    });

    it("should find contracts by value substring", () => {
      MemoryContract.setContract(runId, "context", "key1", { description: "authentication system" });
      MemoryContract.setContract(runId, "context", "key2", { description: "database connection" });

      const results = MemoryContract.searchByKeyword(runId, "authentication");
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, "key1");
    });
  });

  describe("getWorkingSet", () => {
    it("should return highest priority contracts first", () => {
      MemoryContract.setContract(runId, "context", "low", {}, 1);
      MemoryContract.setContract(runId, "context", "high", {}, 10);
      MemoryContract.setContract(runId, "context", "med", {}, 5);

      const workingSet = MemoryContract.getWorkingSet(runId, 2);
      assert.strictEqual(workingSet.length, 2);
      assert.strictEqual(workingSet[0].key, "high");
      assert.strictEqual(workingSet[1].key, "med");
    });

    it("should boost frequently accessed contracts", () => {
      MemoryContract.setContract(runId, "context", "frequent", {}, 5);
      MemoryContract.setContract(runId, "context", "rare", {}, 6);

      // Access frequent multiple times
      for (let i = 0; i < 10; i++) {
        MemoryContract.getContract(runId, "frequent");
      }

      const workingSet = MemoryContract.getWorkingSet(runId, 2);
      // Frequent should be first due to access count boost
      assert.strictEqual(workingSet[0].key, "frequent");
    });
  });

  describe("Checkpoint System", () => {
    it("should create and retrieve checkpoints", () => {
      const checkpointData = {
        completedStories: ["story-1"],
        currentStory: "story-2",
        branch: "feature/test"
      };

      const id = MemoryContract.createCheckpoint(runId, "step-5", checkpointData);
      assert.ok(id);

      const retrieved = MemoryContract.getLatestCheckpoint(runId);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.step_id, "step-5");
      assert.deepStrictEqual(retrieved.checkpoint_data, checkpointData);
    });

    it("should return most recent checkpoint", async () => {
      MemoryContract.createCheckpoint(runId, "step-1", { v: 1 });
      await new Promise(r => setTimeout(r, 10));
      MemoryContract.createCheckpoint(runId, "step-2", { v: 2 });
      await new Promise(r => setTimeout(r, 10));
      MemoryContract.createCheckpoint(runId, "step-3", { v: 3 });

      const latest = MemoryContract.getLatestCheckpoint(runId);
      assert.ok(latest);
      assert.deepStrictEqual(latest?.checkpoint_data, { v: 3 });
    });

    it("should prune old checkpoints (keep last 10)", async () => {
      // Create 15 checkpoints with small delays
      for (let i = 0; i < 15; i++) {
        MemoryContract.createCheckpoint(runId, `step-${i}`, { index: i });
        await new Promise(r => setTimeout(r, 5));
      }

      // Check that only recent ones exist (at most 10-11 due to timing)
      const db = getDb();
      const count = db.prepare(
        "SELECT COUNT(*) as count FROM memory_checkpoints WHERE run_id = ?"
      ).get(runId) as { count: number };
      
      assert.ok(count.count <= 11, `Expected at most 11 checkpoints, got ${count.count}`);
    });
  });

  describe("Session Index / Audit Log", () => {
    it("should log write operations", () => {
      MemoryContract.setContract(runId, "context", "logged_key", {});
      
      const logs = MemoryContract.getSessionLog(runId);
      const writeLog = logs.find(l => l.operation === "write" && l.key === "logged_key");
      assert.ok(writeLog);
      assert.strictEqual(writeLog.success, 1);
    });

    it("should log read operations", () => {
      MemoryContract.setContract(runId, "context", "read_key", {});
      MemoryContract.getContract(runId, "read_key");
      
      const logs = MemoryContract.getSessionLog(runId);
      const readLog = logs.find(l => l.operation === "read" && l.key === "read_key");
      assert.ok(readLog);
      assert.strictEqual(readLog.success, 1);
    });

    it("should log failed reads", () => {
      MemoryContract.getContract(runId, "non_existent_key");
      
      const logs = MemoryContract.getSessionLog(runId);
      const failedLog = logs.find(l => l.operation === "read" && l.key === "non_existent_key");
      assert.ok(failedLog);
      assert.strictEqual(failedLog.success, 0);
    });
  });

  describe("clearRun", () => {
    it("should delete all data for a run", () => {
      MemoryContract.setContract(runId, "context", "k1", {});
      MemoryContract.createCheckpoint(runId, "step-1", {});

      MemoryContract.clearRun(runId);

      assert.strictEqual(MemoryContract.getAllForRun(runId).length, 0);
      assert.strictEqual(MemoryContract.getLatestCheckpoint(runId), null);
    });
  });
});
