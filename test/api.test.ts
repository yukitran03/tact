import { describe, expect, test } from "bun:test";
import { createApi } from "../src/server/api";
import { Engine } from "../src/core/engine";
import { MemoryService } from "../src/memory/service";
import { MockBackend } from "../src/memory/backend";
import { Ledger } from "../src/memory/ledger";
import type { App } from "../src/app";

function setup() {
  const ledger = new Ledger(":memory:");
  const backend = new MockBackend();
  const memory = new MemoryService(backend, ledger, { namespaceSecret: "t", prefix: "api", pollMs: 5 });
  const engine = new Engine(memory, ledger, null, { polishBudgetMs: 0, answerBudgetMs: 0 });
  const app = { ledger, backend, memory, engine, llm: { label: "none", health: async () => ({ ok: false, detail: "none" }) }, settings: { sessionSecret: "s" } } as unknown as App;
  const api = createApi(app);
  const call = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const req = new Request(`http://x${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const res = (await api(req, new URL(req.url)))!;
    const cookie = res.headers.get("set-cookie")?.split(";")[0];
    return { status: res.status, data: res.status === 302 ? null : await res.json(), cookie, res };
  };
  return { ledger, memory, call };
}

describe("api", () => {
  test("sessions, tables, invites and per-person privacy of receipts", async () => {
    const { call, memory } = setup();
    const linh = (await call("/api/session", { body: { name: "Linh" } })).cookie!;
    const minh = (await call("/api/session", { body: { name: "Minh" } })).cookie!;
    expect((await call("/api/me")).status).toBe(401);

    const g = (await call("/api/groups", { body: { name: "Lunch" }, cookie: linh })).data.group;
    expect((await call(`/api/groups/${g.id}`, { cookie: minh })).status).toBe(404); // not a member yet
    await call("/api/groups/join", { body: { code: g.inviteCode }, cookie: minh });
    expect((await call(`/api/groups/${g.id}`, { cookie: minh })).status).toBe(200);

    await call("/api/dm", { body: { text: "I'm allergic to shrimp" }, cookie: linh });
    await call(`/api/groups/${g.id}/messages`, { body: { text: "add place: Ốc Đào, seafood snails, ~150k, District 4" }, cookie: linh });
    await call(`/api/groups/${g.id}/messages`, { body: { text: "add place: Phở Lan, pho, vegetarian options, ~65k" }, cookie: minh });
    await memory.drain(5000);
    const planned = await call(`/api/groups/${g.id}/messages`, { body: { text: "where should we eat friday?" }, cookie: minh });
    const plan = planned.data.messages.find((m: any) => m.meta?.type === "plan");
    expect(plan.meta.choice.name).toBe("Phở Lan");
    expect(planned.data.out.some((o: any) => o.roomType === "dm")).toBe(false); // Minh gets no note about Linh

    const linhReceipt = (await call(`/api/plans/${plan.meta.planId}`, { cookie: linh })).data;
    const minhReceipt = (await call(`/api/plans/${plan.meta.planId}`, { cookie: minh })).data;
    expect(linhReceipt.mine.some((i: any) => i.kind === "allergy")).toBe(true);
    expect(JSON.stringify(minhReceipt).toLowerCase()).not.toContain("allerg");
    expect(JSON.stringify(minhReceipt).toLowerCase()).not.toContain("shellfish");

    // Minh's memory endpoint never shows Linh's facts.
    const minhMem = (await call("/api/memory/me", { cookie: minh })).data;
    expect(minhMem.facts.length).toBe(0);
    const linhShield = (await call("/api/shield", { cookie: linh })).data.entries;
    expect(linhShield.length).toBeGreaterThan(0);
    expect((await call("/api/shield", { cookie: minh })).data.entries.length).toBe(0);
  });

  test("only demo personas can be opened by link; forged cookies are rejected", async () => {
    const { call, ledger } = setup();
    const real = ledger.upsertMember("web", "real", "Real Person");
    const demo = ledger.upsertMember("seed", "demo-x", "Demo X", true);
    expect((await call("/api/demo/as", { body: { memberId: real.id } })).status).toBe(403);
    const ok = await call("/api/demo/as", { body: { memberId: demo.id } });
    expect(ok.status).toBe(200);
    expect((await call(`/api/demo/open?as=${real.id}`)).status).toBe(404);
    expect((await call(`/api/demo/open?as=${demo.id}`)).status).toBe(302);
    expect((await call("/api/me", { cookie: `tact_sid=${real.id}.forged` })).status).toBe(401);
  });
});
