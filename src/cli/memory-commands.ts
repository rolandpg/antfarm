import { MemoryContract } from "../lib/memory.js";
import { getDb } from "../db.js";

/**
 * Memory CLI commands for debugging and management
 */
export function memoryCommand(args: string[]): number {
  const subcommand = args[0];
  const runId = args[1];

  switch (subcommand) {
    case "list":
      return listContracts(runId);
    case "get":
      return getContract(runId, args[2]);
    case "search":
      return searchMemory(runId, args[2]);
    case "log":
      return showLog(runId);
    case "checkpoint":
      return showCheckpoint(runId);
    case "clear":
      return clearRun(runId);
    default:
      console.log(`Usage: antfarm memory <command> [options]
Commands:
  list <run-id>              List all contracts for a run
  get <run-id> <key>         Get specific contract by key
  search <run-id> <keyword>  Search contracts by keyword
  log <run-id>               Show session operation log
  checkpoint <run-id>        Show latest checkpoint
  clear <run-id>             Clear all memory for a run
`);
      return 1;
  }
}

function listContracts(runId: string | undefined): number {
  if (!runId) {
    console.error("Error: run-id required");
    return 1;
  }
  const contracts = MemoryContract.getAllForRun(runId, 100);
  console.log(`\nMemory contracts for run ${runId}:`);
  console.log("-".repeat(80));
  console.log(`${"Type".padEnd(12)} ${"Key".padEnd(30)} ${"Priority".padEnd(10)} ${"Accessed"}`);
  console.log("-".repeat(80));
  for (const c of contracts) {
    const accessed = c.access_count > 0 ? `${c.access_count}x` : "-";
    console.log(`${c.contract_type.padEnd(12)} ${c.key.slice(0, 30).padEnd(30)} ${String(c.priority).padEnd(10)} ${accessed}`);
  }
  console.log(`\nTotal: ${contracts.length} contracts`);
  return 0;
}

function getContract(runId: string | undefined, key: string | undefined): number {
  if (!runId || !key) {
    console.error("Error: run-id and key required");
    return 1;
  }
  const contract = MemoryContract.getContract(runId, key);
  if (!contract) {
    console.log(`No contract found for key: ${key}`);
    return 1;
  }
  console.log(`\nContract: ${key}`);
  console.log("-".repeat(50));
  console.log(`Type:     ${contract.contract_type}`);
  console.log(`Priority: ${contract.priority}`);
  console.log(`Created:  ${contract.created_at}`);
  console.log(`Accessed: ${contract.access_count || 0} times`);
  console.log(`\nValue:`);
  console.log(JSON.stringify(contract.value, null, 2));
  return 0;
}

function searchMemory(runId: string | undefined, keyword: string | undefined): number {
  if (!runId || !keyword) {
    console.error("Error: run-id and keyword required");
    return 1;
  }
  const results = MemoryContract.searchByKeyword(runId, keyword);
  console.log(`\nSearch results for "${keyword}" in run ${runId}:`);
  console.log("-".repeat(80));
  for (const c of results) {
    console.log(`[${c.contract_type}] ${c.key}`);
  }
  console.log(`\nTotal: ${results.length} results`);
  return 0;
}

function showLog(runId: string | undefined): number {
  if (!runId) {
    console.error("Error: run-id required");
    return 1;
  }
  const logs = MemoryContract.getSessionLog(runId, 50);
  console.log(`\nSession log for run ${runId}:`);
  console.log("-".repeat(80));
  console.log(`${"Time".padEnd(20)} ${"Operation".padEnd(15)} ${"Key".padEnd(25)} ${"Status"}`);
  console.log("-".repeat(80));
  for (const log of logs) {
    const time = new Date(log.timestamp).toLocaleTimeString();
    const status = log.success ? "✓" : "✗";
    console.log(`${time.padEnd(20)} ${log.operation.padEnd(15)} ${(log.key || "").slice(0, 25).padEnd(25)} ${status}`);
  }
  return 0;
}

function showCheckpoint(runId: string | undefined): number {
  if (!runId) {
    console.error("Error: run-id required");
    return 1;
  }
  const checkpoint = MemoryContract.getLatestCheckpoint(runId);
  if (!checkpoint) {
    console.log("No checkpoint found");
    return 1;
  }
  console.log(`\nLatest checkpoint for run ${runId}:`);
  console.log("-".repeat(50));
  console.log(`Step:      ${checkpoint.step_id}`);
  console.log(`Created:   ${checkpoint.created_at}`);
  console.log(`\nData:`);
  console.log(JSON.stringify(checkpoint.checkpoint_data, null, 2));
  return 0;
}

function clearRun(runId: string | undefined): number {
  if (!runId) {
    console.error("Error: run-id required");
    return 1;
  }
  console.log(`Clearing all memory for run ${runId}...`);
  MemoryContract.clearRun(runId);
  console.log("Done.");
  return 0;
}
