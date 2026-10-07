import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTactMcpServer, handleMcpHttp, TOOL_NAMES } from "../src/channels/mcp";
import { Engine } from "../src/core/engine";
import { MemoryService } from "../src/memory/service";
import { MockBackend } from "../src/memory/backend";
import { Ledger } from "../src/memory/ledger";
import { fold } from "../src/core/lexicon";
import type { App } from "../src/app";

function makeApp(): App {
  const ledger = new Ledger(":memory:");
  const backend = new MockBackend();
  const memory = new MemoryService(backend, ledger, { namespaceSecret: "t", prefix: "mcp", pollMs: 5 });
  const engine = new Engine(memory, ledger, null, { polishBudgetMs: 0, answerBudgetMs: 0 });
  return { ledger, backend, memory, engine, llm: null as any, settings: { publicUrl: "http://localhost" } as any };
}

const textOf = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

async function connect(app: App, memberId: string, label = "Claude Code") {
  const member = app.ledger.member(memberId)!;
  const server = createTactMcpServer(app, member, label);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
}

describe("MCP server", () => {
  const app = makeApp();
  const table = app.ledger.upsertGroup("web", "t", "Friday Table");
  const an = app.ledger.upsertMember("web", "an", "An");
  const bao = app.ledger.upsertMember("web", "bao", "Bảo");
  app.ledger.addToGroup(table.id, an.id);
  app.ledger.addToGroup(table.id, bao.id);

  test("lists every tool", async () => {
    const c = await connect(app, an.id);
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([...TOOL_NAMES].sort());
  });

  test("an agent stores facts for its own member and plans without leaking the other member's secrets", async () => {
    const baoAgent = await connect(app, bao.id, "Codex");
    const saved = await baoAgent.callTool({ name: "tact_remember", arguments: { text: "I'm allergic to shrimp and crab, keep it between us" } });
    expect(textOf(saved)).toContain("shellfish");
    const anAgent = await connect(app, an.id);
    await anAgent.callTool({ name: "tact_add_place", arguments: { table: "Friday Table", place: "Ốc Đào, seafood snails, ~150k, District 4" } });
    await anAgent.callTool({ name: "tact_add_place", arguments: { table: table.inviteCode, place: "Phở Lan, pho, vegetarian options, ~65k" } });
    await app.memory.drain(5000);

    const planned = JSON.parse(textOf(await anAgent.callTool({ name: "tact_plan", arguments: { table: "Friday Table", request: "seafood dinner friday" } })));
    const all = JSON.stringify(planned);
    expect(planned.group[0]).toContain("Phở Lan");
    expect(fold(all)).not.toContain("allerg");
    expect(fold(all)).not.toContain("shrimp");
    expect(planned.receipt.privateDetailsSharedWithTheTable).toBe(0);
    expect(planned.receipt.yourMemoriesUsed.length).toBe(0); // An's receipt shows nothing of Bảo's
    expect(planned.privateNotes.length).toBe(0);

    // Bảo's own agent may ask why, and gets Bảo's reasons only.
    const why = textOf(await baoAgent.callTool({ name: "tact_why", arguments: { place: "Ốc Đào" } }));
    expect(why).toContain("allergic");
    // An's agent asking the same gets nothing about Bảo.
    const anWhy = textOf(await anAgent.callTool({ name: "tact_why", arguments: { place: "Ốc Đào" } }));
    expect(fold(anWhy)).not.toContain("allergic");
  });

  test("memory tools are scoped to the token's member", async () => {
    const anAgent = await connect(app, an.id);
    const mine = JSON.parse(textOf(await anAgent.callTool({ name: "tact_my_memory", arguments: {} })));
    expect(mine.every((f: any) => !/shellfish/.test(f.text))).toBe(true);
    const tableMem = JSON.parse(textOf(await anAgent.callTool({ name: "tact_table_memory", arguments: { table: "Friday Table" } })));
    expect(tableMem.places.length).toBe(2);
    expect(fold(JSON.stringify(tableMem))).not.toContain("shellfish");
    const wrongTable = await anAgent.callTool({ name: "tact_plan", arguments: { table: "Somebody else's table", request: "dinner" } });
    expect(wrongTable.isError).toBe(true);
  });

  test("set tier and forget work through the agent", async () => {
    const baoAgent = await connect(app, bao.id);
    await baoAgent.callTool({ name: "tact_remember", arguments: { text: "I love spicy food" } });
    await app.memory.drain(5000);
    const t = await baoAgent.callTool({ name: "tact_set_tier", arguments: { key: "like:spicy", tier: "private" } });
    expect(textOf(t)).toMatch(/now private/);
    const f = await baoAgent.callTool({ name: "tact_forget", arguments: { key: "like:spicy" } });
    expect(textOf(f)).toMatch(/Retracted/);
    await app.memory.drain(5000);
    app.memory.invalidate(app.memory.namespaceOf({ type: "member", id: bao.id }));
    const mine = JSON.parse(textOf(await baoAgent.callTool({ name: "tact_my_memory", arguments: {} })));
    expect(mine.some((x: any) => x.key === "like:spicy")).toBe(false);
  });
});

describe("MCP over streamable HTTP", () => {
  const app = makeApp();
  const m = app.ledger.upsertMember("web", "linh", "Linh");
  const { token, id } = app.ledger.createAgentToken(m.id, "Cursor");
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/mcp" ? handleMcpHttp(app, req) : new Response("no", { status: 404 })) });
  });
  afterAll(() => server.stop(true));

  test("rejects a missing or wrong token", async () => {
    const r1 = await fetch(`http://localhost:${server.port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r1.status).toBe(401);
    const r2 = await fetch(`http://localhost:${server.port}/mcp`, { method: "POST", headers: { authorization: "Bearer tact_nope", "content-type": "application/json" }, body: "{}" });
    expect(r2.status).toBe(401);
  });

  test("a real MCP client connects with a bearer token and calls tools", async () => {
    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const who = JSON.parse(textOf(await client.callTool({ name: "tact_whoami", arguments: {} })));
    expect(who.member).toBe("Linh");
    expect(who.agent).toBe("Cursor");
    const saved = textOf(await client.callTool({ name: "tact_remember", arguments: { text: "My budget is 90k max" } }));
    expect(saved).toContain("90k");
    await client.close();
  });

  test("a revoked token stops working", async () => {
    expect(app.ledger.revokeAgentToken(m.id, id)).toBe(true);
    const r = await fetch(`http://localhost:${server.port}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
  });
});
