import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { getDb } from "../db.js";

interface Contract {
  id: string;
  run_id: string;
  contract_type: 'constraint' | 'decision' | 'context' | 'checkpoint';
  key: string;
  value: any;
  priority: number;
  created_at: string;
  accessed_at?: string;
  access_count: number;
}

/**
 * MemoryContract API - Explicit memory persistence for antfarm workflows
 * Prevents missed writes, missed retrieval, and compaction loss
 */
export class MemoryContract {
  /**
   * Create a new memory contract
   */
  static setContract(
    runId: string,
    type: 'constraint' | 'decision' | 'context' | 'checkpoint',
    key: string,
    value: any,
    priority: number = 5
  ): string {
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO memory_contracts (id, run_id, contract_type, key, value, priority, created_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(run_id, key) DO UPDATE SET
        value = excluded.value,
        contract_type = excluded.contract_type,
        priority = excluded.priority,
        accessed_at = NULL,
        access_count = 0
    `);
    stmt.run(id, runId, type, key, JSON.stringify(value), priority, now);
    this._logOperation(runId, "write", key, true);
    return id;
  }

  /**
   * Retrieve a contract by key
   */
  static getContract(runId: string, key: string): Contract | null {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM memory_contracts
      WHERE run_id = ? AND key = ?
    `);
    const row = stmt.get(runId, key) as Contract | undefined;
    
    if (row) {
      this._markAccessed(row.id);
      this._logOperation(runId, "read", key, true);
      return {
        ...row,
        value: JSON.parse(row.value as string)
      };
    }
    this._logOperation(runId, "read", key, false);
    return null;
  }

  /**
   * Search contracts by type
   */
  static searchContracts(runId: string, type: string): Contract[] {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM memory_contracts
      WHERE run_id = ? AND contract_type = ?
      ORDER BY priority DESC, created_at DESC
    `);
    const rows = stmt.all(runId, type) as unknown as unknown as Contract[];
    rows.forEach(row => this._markAccessed(row.id));
    this._logOperation(runId, "search", type, rows.length > 0);
    return rows.map(row => ({
      ...row,
      value: JSON.parse(row.value as string)
    }));
  }

  /**
   * Get all contracts for a run
   */
  static getAllForRun(runId: string, limit: number = 100): Contract[] {
    const db = getDb();
    
    // Enforce max contracts per run - evict lowest priority oldest first
    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM memory_contracts WHERE run_id = ?`);
    const { count } = countStmt.get(runId) as { count: number };
    
    if (count > limit) {
      this._evictOldest(runId, count - limit);
    }
    
    const stmt = db.prepare(`
      SELECT * FROM memory_contracts
      WHERE run_id = ?
      ORDER BY priority DESC, created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(runId, limit) as unknown as Contract[];
    return rows.map(row => ({
      ...row,
      value: JSON.parse(row.value as string)
    }));
  }

  /**
   * Get contracts by priority threshold
   */
  static getByPriority(runId: string, minPriority: number = 5): Contract[] {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM memory_contracts
      WHERE run_id = ? AND priority >= ?
      ORDER BY priority DESC, created_at DESC
    `);
    const rows = stmt.all(runId, minPriority) as unknown as Contract[];
    rows.forEach(row => this._markAccessed(row.id));
    return rows.map(row => ({
      ...row,
      value: JSON.parse(row.value as string)
    }));
  }

  /**
   * Create a checkpoint
   */
  static createCheckpoint(runId: string, stepId: string, data: any): string {
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    
    // Prune old checkpoints (keep last 10)
    const pruneStmt = db.prepare(`
      DELETE FROM memory_checkpoints
      WHERE id IN (
        SELECT id FROM memory_checkpoints
        WHERE run_id = ?
        ORDER BY created_at DESC
        LIMIT -1 OFFSET 10
      )
    `);
    pruneStmt.run(runId);
    
    const stmt = db.prepare(`
      INSERT INTO memory_checkpoints (id, run_id, step_id, checkpoint_data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, runId, stepId, JSON.stringify(data), now);
    this._logOperation(runId, "checkpoint", stepId, true);
    return id;
  }

  /**
   * Get latest checkpoint for a run
   */
  static getLatestCheckpoint(runId: string): any | null {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM memory_checkpoints
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(runId) as any;
    
    if (row) {
      this._logOperation(runId, "restore", row.step_id, true);
      return {
        ...row,
        checkpoint_data: JSON.parse(row.checkpoint_data)
      };
    }
    return null;
  }

  /**
   * Search contracts by keyword (simple substring match)
   */
  static searchByKeyword(runId: string, keyword: string): Contract[] {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM memory_contracts
      WHERE run_id = ? AND (key LIKE ? OR value LIKE ?)
      ORDER BY priority DESC, created_at DESC
    `);
    const pattern = `%${keyword}%`;
    const rows = stmt.all(runId, pattern, pattern) as unknown as Contract[];
    rows.forEach(row => this._markAccessed(row.id));
    this._logOperation(runId, "keyword_search", keyword, rows.length > 0);
    return rows.map(row => ({
      ...row,
      value: JSON.parse(row.value as string)
    }));
  }

  /**
   * Get working set - highest priority + most recently accessed contracts
   */
  static getWorkingSet(runId: string, maxSize: number = 20): Contract[] {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM memory_contracts
      WHERE run_id = ?
      ORDER BY 
        (priority * 10 + COALESCE(access_count, 0)) DESC,
        accessed_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(runId, maxSize) as unknown as Contract[];
    return rows.map(row => ({
      ...row,
      value: JSON.parse(row.value as string)
    }));
  }

  /**
   * Delete all contracts for a run
   */
  static clearRun(runId: string): void {
    const db = getDb();
    db.prepare("DELETE FROM memory_contracts WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM memory_checkpoints WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM session_index WHERE run_id = ?").run(runId);
    this._logOperation(runId, "clear", null, true);
  }

  /**
   * Mark a contract as accessed
   */
  private static _markAccessed(id: string): void {
    const db = getDb();
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      UPDATE memory_contracts
      SET accessed_at = ?, access_count = COALESCE(access_count, 0) + 1
      WHERE id = ?
    `);
    stmt.run(now, id);
  }

  /**
   * Evict oldest/lowest priority contracts
   */
  private static _evictOldest(runId: string, count: number): void {
    const db = getDb();
    const stmt = db.prepare(`
      DELETE FROM memory_contracts
      WHERE id IN (
        SELECT id FROM memory_contracts
        WHERE run_id = ?
        ORDER BY priority ASC, created_at ASC
        LIMIT ?
      )
    `);
    stmt.run(runId, count);
  }

  /**
   * Log a memory operation for auditing
   */
  private static _logOperation(
    runId: string,
    operation: string,
    key: string | null,
    success: boolean,
    details: any = null
  ): void {
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO session_index (id, run_id, operation, key, success, details, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, runId, operation, key, success ? 1 : 0, details ? JSON.stringify(details) : null, now);
  }

  /**
   * Get session audit log for a run
   */
  static getSessionLog(runId: string, limit: number = 100): any[] {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM session_index
      WHERE run_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(runId, limit) as any[];
  }
}
