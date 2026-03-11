import { MemoryContract } from "./memory.js";
import { getDb } from "../db.js";

/**
 * QMD (Query-Model-Data) Layer - Semantic search for memory contracts
 * Provides ranked retrieval using multiple strategies:
 * - Exact match
 * - Keyword/substring match  
 * - N-gram overlap (semantic similarity)
 * - Priority boosting
 */

interface SearchResult {
  contract: any;
  score: number;
  strategy: string;
}

/**
 * Generate n-grams from text
 */
function ngrams(text: string, n: number = 3): string[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const grams: string[] = [];
  for (let i = 0; i <= normalized.length - n; i++) {
    grams.push(normalized.slice(i, i + n).join(' '));
  }
  return grams;
}

/**
 * Calculate Jaccard similarity between two sets
 */
function jaccardSimilarity(setA: string[], setB: string[]): number {
  const a = new Set(setA);
  const b = new Set(setB);
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

/**
 * Calculate relevance score for a contract against a query
 */
function calculateScore(contract: any, query: string): { score: number; strategy: string } {
  const queryLower = query.toLowerCase();
  const keyLower = contract.key.toLowerCase();
  const valueStr = JSON.stringify(contract.value).toLowerCase();
  
  // Exact key match (highest priority)
  if (keyLower === queryLower) {
    return { score: 1.0, strategy: 'exact_key' };
  }
  
  // Key contains query
  if (keyLower.includes(queryLower)) {
    return { score: 0.9, strategy: 'key_contains' };
  }
  
  // Value contains query
  if (valueStr.includes(queryLower)) {
    return { score: 0.7, strategy: 'value_contains' };
  }
  
  // N-gram semantic similarity
  const queryGrams = ngrams(query);
  const contractText = `${keyLower} ${valueStr}`;
  const contractGrams = ngrams(contractText);
  
  if (queryGrams.length > 0 && contractGrams.length > 0) {
    const similarity = jaccardSimilarity(queryGrams, contractGrams);
    if (similarity > 0.1) {
      return { score: 0.5 + (similarity * 0.3), strategy: 'semantic' };
    }
  }
  
  return { score: 0, strategy: 'no_match' };
}

/**
 * Query the memory system with ranked results
 */
export function queryMemory(runId: string, query: string, options: {
  type?: 'constraint' | 'decision' | 'context' | 'checkpoint';
  minPriority?: number;
  limit?: number;
  minScore?: number;
} = {}): SearchResult[] {
  const { type, minPriority = 1, limit = 10, minScore = 0.3 } = options;
  
  // Get candidate contracts
  let contracts: any[];
  if (type) {
    contracts = MemoryContract.searchContracts(runId, type);
  } else {
    contracts = MemoryContract.getAllForRun(runId, 100);
  }
  
  // Filter by priority
  contracts = contracts.filter(c => c.priority >= minPriority);
  
  // Score and rank
  const results: SearchResult[] = contracts
    .map(contract => {
      const { score, strategy } = calculateScore(contract, query);
      // Boost by priority (0.05 per priority level)
      const priorityBoost = (contract.priority - 5) * 0.05;
      return {
        contract,
        score: Math.min(1.0, score + priorityBoost),
        strategy
      };
    })
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  // Log the query
  MemoryContract.getSessionLog(runId); // Just to ensure logging
  
  return results;
}

/**
 * Find related contracts using graph traversal
 * Contracts are related if they share keywords or were accessed together
 */
export function findRelated(runId: string, key: string, depth: number = 1): any[] {
  const db = getDb();
  const visited = new Set<string>();
  const related: any[] = [];
  
  function traverse(currentKey: string, currentDepth: number) {
    if (currentDepth > depth || visited.has(currentKey)) return;
    visited.add(currentKey);
    
    // Find contracts accessed in same session
    const coAccessed = db.prepare(`
      SELECT DISTINCT c.* FROM memory_contracts c
      JOIN session_index s1 ON s1.key = ?
      JOIN session_index s2 ON s2.run_id = s1.run_id 
        AND s2.timestamp BETWEEN datetime(s1.timestamp, '-5 minutes') AND datetime(s1.timestamp, '+5 minutes')
      WHERE c.key = s2.key AND c.run_id = ? AND c.key != ?
    `).all(currentKey, runId, currentKey) as any[];
    
    for (const contract of coAccessed) {
      if (!visited.has(contract.key)) {
        related.push(contract);
        traverse(contract.key, currentDepth + 1);
      }
    }
  }
  
  traverse(key, 0);
  return related;
}

/**
 * Smart suggest - suggest relevant contracts based on current context
 */
export function suggestRelevant(runId: string, context: string, limit: number = 5): any[] {
  // Extract keywords from context
  const keywords = context.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !['this', 'that', 'with', 'from', 'have', 'been', 'they', 'will', 'would', 'there', 'their'].includes(w));
  
  // Score contracts by keyword overlap
  const allContracts = MemoryContract.getAllForRun(runId, 100);
  const scored = allContracts.map(contract => {
    const contractText = `${contract.key} ${JSON.stringify(contract.value)}`.toLowerCase();
    const matches = keywords.filter(k => contractText.includes(k)).length;
    return { contract, score: matches / keywords.length };
  });
  
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.contract);
}

/**
 * Export search interface
 */
export const QMD = {
  query: queryMemory,
  findRelated,
  suggestRelevant
};
