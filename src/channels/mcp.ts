import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { App } from "../app";
import type { Group, Member, Tier } from "../core/types";
import { publicFactView, type StoredPlan } from "../core/engine";
import { venuesFrom } from "../core/planner";
import { fold } from "../core/lexicon";

/**
 * Tact over the Model Context Protocol. An agent (Claude Code, Codex, Cursor,
 * Claude Desktop) connects with a member's agent token and acts as that member,
 * with exactly that member's view: it can read and change their own memory and
 * talk to their tables, and it sees other people only through what they shared.
 * Every action goes through the same engine and the same privacy scan as a chat.
 */

const VERSION = "0.2.0";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown): Text => text(JSON.stringify(v, null, 2));
const fail = (t: string): Text => ({ content: [{ type: "text", text: t }], isError: true });

export const TOOL_NAMES = [
  "tact_whoami", "tact_tables", "tact_join_table", "tact_remember", "tact_import_memory", "tact_my_memory",
  "tact_set_tier", "tact_forget", "tact_add_place", "tact_plan", "tact_confirm", "tact_why", "tact_table_memory",
] as const;

export function createTactMcpServer(app: App, member: Member, agentLabel = "agent"): McpServer {
  const { ledger, engine, memory } = app;
  const via = `agent:${agentLabel}`;
  const server = new McpServer({ name: "tact", version: VERSION }, {
    instructions:
      "Tact is a group chat bot with per-person memory on Walrus. You act for one member. Facts they tell you about " +
      "allergies, diets, budgets, area and busy days are discreet by default: Tact uses them to plan for their tables " +
      "but never says them in a group. Use tact_remember for anything the member wants Tact to know, tact_plan to ask " +
      "a table where to eat, and never try to learn other members' private facts; Tact will not reveal them.",
  });

  const tableFor = (ref: string): Group | null => {
    const mine = ledger.groupsOf(member.id);
    const r = fold(ref.trim());
    return mine.find((g) => g.id === ref || fold(g.inviteCode) === r || fold(g.name) === r)
      ?? mine.find((g) => fold(g.name).includes(r)) ?? null;
  };
  const tableList = () => ledger.groupsOf(member.id).map((g) => ({
    id: g.id, name: g.name, inviteCode: g.inviteCode, members: ledger.groupMembers(g.id).map((m) => m.displayName),
  }));
  const dm = async (t: string) => {
    const out = await engine.handle({ channel: "web", roomType: "dm", roomId: member.id, memberId: member.id, text: t, via });
    return out.map((o) => o.text).join("\n\n");
  };
  const toTable = async (g: Group, t: string) => {
    const out = await engine.handle({ channel: "web", roomType: "group", roomId: g.id, memberId: member.id, text: t, addressed: true, via });
    // The agent sees what the table sees, plus private notes addressed to its own member, never anyone else's.
    const group = out.filter((o) => o.roomType === "group").map((o) => o.text);
    const mine = out.filter((o) => o.roomType === "dm" && o.roomId === member.id).map((o) => o.text);
    const meta = (out.find((o) => o.roomType === "group")?.meta ?? null) as Record<string, any> | null;
    // A consent receipt: counts for everyone, details only for this agent's own member.
    let receipt: unknown = null;
    if (meta?.planId) {
      const row = ledger.plan(String(meta.planId));
      const d = row ? (JSON.parse(row.decision) as StoredPlan) : null;
      if (d) receipt = {
        planId: meta.planId, people: d.attendees.length, memoriesReadFromWalrus: d.memoriesConsulted,
        placesRuledOut: d.ruledOut.length, privateMemoriesNotConsulted: meta.privateSkipped ?? 0,
        privateDetailsSharedWithTheTable: 0,
        yourMemoriesUsed: d.influences.filter((i) => i.memberId === member.id).map((i) => ({ effect: i.effect, why: i.you ?? i.detail, tier: i.tier, blobId: i.blobId ?? null })),
      };
    }
    return { group, privateNotes: mine, receipt };
  };

  server.registerTool("tact_whoami", {
    title: "Who am I in Tact",
    description: "The member this agent acts for, and their tables.",
    annotations: { readOnlyHint: true },
  }, async () => json({ member: member.displayName, agent: agentLabel, tables: tableList() }));

  server.registerTool("tact_tables", {
    title: "List my tables",
    description: "Tables (group chats) this member belongs to, with invite codes and members.",
    annotations: { readOnlyHint: true },
  }, async () => json(tableList()));

  server.registerTool("tact_join_table", {
    title: "Join a table",
    description: "Join a table with its six-letter invite code.",
    inputSchema: { code: z.string().min(4).max(12).describe("Six-letter invite code") },
  }, async ({ code }) => {
    const g = ledger.groupByInvite(code);
    if (!g) return fail("No table with that code.");
    ledger.addToGroup(g.id, member.id);
    return json({ joined: g.name, id: g.id });
  });

  server.registerTool("tact_remember", {
    title: "Tell Tact something private",
    description: "Tell Tact a fact about this member in plain words (English or Vietnamese), e.g. \"allergic to peanuts\", " +
      "\"budget 120k per meal\", \"busy on Thursdays\", \"loves spicy food\". Saved to the member's own Walrus Memory namespace. " +
      "Allergies, diets, budgets, area and busy days are discreet: used for group plans, never said.",
    inputSchema: { text: z.string().min(2).max(2000).describe("What the member wants Tact to know") },
  }, async ({ text: t }) => text(await dm(t)));

  server.registerTool("tact_import_memory", {
    title: "Import memory from another assistant",
    description: "Paste what ChatGPT, Claude or another assistant remembers about this member. Tact keeps only food, " +
      "budget, area and availability facts, as discreet, and ignores the rest.",
    inputSchema: { text: z.string().min(2).max(20000).describe("The exported memory, one fact per line is best") },
  }, async ({ text: t }) => text(await dm(`import:\n${t}`)));

  server.registerTool("tact_my_memory", {
    title: "Read my memory",
    description: "Everything Tact remembers about this member, read back from Walrus, with tier, key and blob id.",
    annotations: { readOnlyHint: true },
  }, async () => {
    const r = await memory.readFacts({ type: "member", id: member.id }, { fresh: true });
    if (r.failed) return fail(`Couldn't read memory from Walrus just now: ${r.error ?? "unknown error"}`);
    return json(r.facts.map(publicFactView));
  });

  server.registerTool("tact_set_tier", {
    title: "Change who a memory reaches",
    description: "Set a memory's tier: discreet (used for plans, never said), shared (can be said in the group), private (never used for groups).",
    inputSchema: {
      key: z.string().describe("The memory's key from tact_my_memory, e.g. allergy:peanut"),
      tier: z.enum(["discreet", "shared", "private"]),
    },
  }, async ({ key, tier }) => {
    const r = await memory.readFacts({ type: "member", id: member.id }, { fresh: true });
    const f = r.facts.find((x) => x.key === key);
    if (!f) return fail(`No memory with key ${key}.`);
    await memory.writeFact({ type: "member", id: member.id }, { ...f, tier: tier as Tier, at: new Date().toISOString(), quote: undefined });
    return text(`${f.text} is now ${tier}. The change is being written to Walrus.`);
  });

  server.registerTool("tact_forget", {
    title: "Retract a memory",
    description: "Stop Tact using a memory. Walrus Memory is append-only, so a retraction is written that supersedes it; the old encrypted blob stays until its storage expires.",
    inputSchema: { key: z.string().describe("The memory's key from tact_my_memory") },
    annotations: { destructiveHint: true },
  }, async ({ key }) => {
    const r = await memory.readFacts({ type: "member", id: member.id }, { fresh: true });
    const f = r.facts.find((x) => x.key === key);
    if (!f) return fail(`No memory with key ${key}.`);
    await memory.writeFact({ type: "member", id: member.id }, { ...f, retract: true, text: `Retracted: ${f.text}`, at: new Date().toISOString(), quote: undefined });
    return text(`Retracted: ${f.text}`);
  });

  server.registerTool("tact_add_place", {
    title: "Add a place to a table",
    description: "Add a place the table knows, e.g. \"Phở Lan, phở bò, ~65k, District 3, vegetarian options\". Shared with the table.",
    inputSchema: {
      table: z.string().describe("Table id, name or invite code"),
      place: z.string().min(2).max(300).describe("Name, food, ~price, area, notes"),
    },
  }, async ({ table, place }) => {
    const g = tableFor(table);
    if (!g) return fail("Not one of this member's tables. Use tact_tables.");
    return json(await toTable(g, `add place: ${place}`));
  });

  server.registerTool("tact_plan", {
    title: "Ask a table where to go",
    description: "Ask Tact to pick a place for a table, e.g. \"dinner Friday\", \"lunch with An and Bảo\", \"Saturday without Dũng\". " +
      "Returns exactly what the table sees, plus any private note for this member. The message appears in the table as sent by this member via the agent.",
    inputSchema: {
      table: z.string().describe("Table id, name or invite code"),
      request: z.string().min(2).max(500).describe("The request in plain words"),
    },
  }, async ({ table, request }) => {
    const g = tableFor(table);
    if (!g) return fail("Not one of this member's tables. Use tact_tables.");
    const req = /(eat|lunch|dinner|plan|an|quan|di dau|where)/i.test(fold(request)) ? request : `where should we eat ${request}`;
    return json(await toTable(g, req));
  });

  server.registerTool("tact_confirm", {
    title: "Lock in a place",
    description: "Tell the table you're going to a place. Tact writes the decision to the table's memory on Walrus so it won't suggest it again too soon.",
    inputSchema: { table: z.string(), place: z.string().min(2).max(120) },
  }, async ({ table, place }) => {
    const g = tableFor(table);
    if (!g) return fail("Not one of this member's tables. Use tact_tables.");
    return json(await toTable(g, `chốt ${place}`));
  });

  server.registerTool("tact_why", {
    title: "Why was a place skipped",
    description: "Ask why a place was skipped in a recent plan. Answers only with this member's own reasons; other people's reasons stay private.",
    inputSchema: { place: z.string().optional().describe("The place name, if any") },
    annotations: { readOnlyHint: true },
  }, async ({ place }) => text(await dm(`why did you skip ${place ?? "it"}?`)));

  server.registerTool("tact_table_memory", {
    title: "A table's shared memory",
    description: "Places, verdicts and past decisions a table shares. Never includes what members told Tact privately.",
    inputSchema: { table: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ table }) => {
    const g = tableFor(table);
    if (!g) return fail("Not one of this member's tables. Use tact_tables.");
    const r = await memory.readFacts({ type: "group", id: g.id });
    if (r.failed) return fail(`Couldn't read the table's memory from Walrus just now: ${r.error ?? "unknown error"}`);
    const last = ledger.lastPlan(g.id);
    return json({
      table: g.name,
      places: venuesFrom(r.facts).map((v) => ({ name: v.name, cuisine: v.cuisine, area: v.area, price: v.price, blobId: v.fact.blobId })),
      verdicts: r.facts.filter((f) => f.kind === "verdict").map((f) => f.text),
      decisions: r.facts.filter((f) => f.kind === "event").map((f) => ({ text: f.text, blobId: f.blobId })),
      lastPlan: last ? (JSON.parse(last.decision) as StoredPlan).choice?.name ?? null : null,
    });
  });

  return server;
}

/**
 * Streamable HTTP endpoint for remote agents: POST /mcp with
 * `Authorization: Bearer <agent token>`. Stateless: one server per request.
 */
export async function handleMcpHttp(app: App, req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST (stateless streamable HTTP)." }, id: null }, { status: 405 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  const resolved = token ? app.ledger.resolveAgentToken(token) : null;
  const member = resolved ? app.ledger.member(resolved.memberId) : null;
  if (!member) {
    return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid agent token. Create one in Tact under Memory → Agents." }, id: null },
      { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  const server = createTactMcpServer(app, member, resolved!.label);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Stateless: the response is already materialised (JSON mode), so the pair can be closed.
    void server.close();
  }
}

/** stdio entry for local agents: `TACT_AGENT_TOKEN=... bun src/channels/mcp.ts`. Logs go to stderr only. */
if (import.meta.main) {
  console.log = (...a: unknown[]) => console.error(...a); // stdout belongs to JSON-RPC
  const { createApp } = await import("../app");
  const app = createApp();
  const token = process.env.TACT_AGENT_TOKEN;
  const resolved = token ? app.ledger.resolveAgentToken(token) : null;
  const member = resolved ? app.ledger.member(resolved.memberId) : null;
  if (!member) {
    console.error("Set TACT_AGENT_TOKEN to an agent token from Tact (Memory → Agents, or `bun run agent-token <name>`).");
    process.exit(1);
  }
  app.memory.resumeInFlight();
  const server = createTactMcpServer(app, member, resolved!.label);
  await server.connect(new StdioServerTransport());
  console.error(`Tact MCP (stdio) acting for ${member.displayName} as ${resolved!.label}`);
}
