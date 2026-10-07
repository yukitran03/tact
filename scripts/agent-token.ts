/**
 * Creates an MCP agent token for a member, for local use without the web UI.
 *
 *   bun run agent-token "Bảo" "Claude Code"     # demo persona or any member by display name
 */
import { createApp } from "../src/app";

const [name, label = "Claude Code"] = process.argv.slice(2);
if (!name) {
  console.error('Usage: bun run agent-token "<member display name>" ["<agent label>"]');
  process.exit(1);
}
const app = createApp();
const row = app.ledger.db.query("SELECT id, display_name FROM members WHERE display_name = ? ORDER BY demo DESC, created_at LIMIT 1").get(name) as { id: string; display_name: string } | null;
if (!row) {
  console.error(`No member called ${name}.`);
  process.exit(1);
}
const { token } = app.ledger.createAgentToken(row.id, label);
const url = `${app.settings.publicUrl.replace(/\/$/, "")}/mcp`;
console.log(`Agent token for ${row.display_name} (${label}). Shown once; store it like a password.\n\n${token}\n`);
console.log("Claude Code (HTTP, server running):");
console.log(`  claude mcp add --transport http tact ${url} --header "Authorization: Bearer ${token}"`);
console.log("Claude Code (stdio, no server needed):");
console.log(`  claude mcp add --env TACT_AGENT_TOKEN=${token} --transport stdio tact -- bun ${app.settings.dataDir.replace(/\/\.tact$/, "")}/src/channels/mcp.ts`);
console.log("Codex:");
console.log(`  export TACT_AGENT_TOKEN=${token}`);
console.log(`  codex mcp add tact --url ${url} --bearer-token-env-var TACT_AGENT_TOKEN`);
process.exit(0);
