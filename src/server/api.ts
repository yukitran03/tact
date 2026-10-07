import { createHmac, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app";
import type { Member, Tier } from "../core/types";
import { publicFactView, type StoredPlan } from "../core/engine";
import { venuesFrom } from "../core/planner";
import { newId } from "../memory/ledger";

const COOKIE = "tact_sid";

function sign(secret: string, value: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function sessionCookie(secret: string, memberId: string) {
  const v = `${memberId}.${sign(secret, memberId)}`;
  return `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}`;
}

function readSession(secret: string, req: Request): string | null {
  const raw = req.headers.get("cookie") ?? "";
  const m = new RegExp(`${COOKIE}=([^;]+)`).exec(raw);
  if (!m) return null;
  const i = m[1].lastIndexOf(".");
  if (i <= 0) return null;
  const id = m[1].slice(0, i);
  const sig = Buffer.from(m[1].slice(i + 1));
  const want = Buffer.from(sign(secret, id));
  return sig.length === want.length && timingSafeEqual(sig, want) ? id : null;
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
const bad = (status: number, error: string) => json({ error }, { status });

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function createApi(app: App) {
  const { ledger, engine, memory, settings } = app;
  const secret = settings.sessionSecret;

  const me = (req: Request): Member | null => {
    const id = readSession(secret, req);
    return id ? ledger.member(id) : null;
  };

  const groupView = (groupId: string) => {
    const g = ledger.group(groupId)!;
    return {
      id: g.id, name: g.name, inviteCode: g.inviteCode, demo: g.demo, mode: engine.mode(g.id),
      members: ledger.groupMembers(g.id).map((m) => ({ id: m.id, name: m.displayName, demo: m.demo })),
    };
  };

  const memoryRows = (ownerType: "member" | "group", ownerId: string) =>
    ledger.memoriesOf(ownerType, ownerId).map((r) => ({
      id: r.id, kind: r.kind, tier: r.tier, key: r.key, status: r.status, blobId: r.blob_id, error: r.error, createdAt: r.created_at,
    }));

  return async function handle(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;
    if (!p.startsWith("/api/")) return null;

    if (p === "/api/health") {
      const [mem, llm, id] = await Promise.all([app.backend.health(), app.llm.health(), app.backend.identity().catch(() => null)]);
      return json({ memory: { mode: app.backend.kind, ...mem }, llm: { label: app.llm.label, ...llm }, identity: id });
    }

    if (p === "/api/session" && req.method === "POST") {
      const b = await body<{ name?: string }>(req);
      const name = (b.name ?? "").trim().slice(0, 40);
      if (!name) return bad(400, "name required");
      const m = ledger.upsertMember("web", newId(), name);
      return json({ member: m }, { headers: { "set-cookie": sessionCookie(secret, m.id) } });
    }

    if (p === "/api/session/logout" && req.method === "POST") {
      return json({ ok: true }, { headers: { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0` } });
    }

    // Demo personas are fictional and clearly labelled; anyone may look through their eyes.
    if (p === "/api/demo/as" && req.method === "POST") {
      const b = await body<{ memberId?: string }>(req);
      const target = b.memberId ? ledger.member(b.memberId) : null;
      if (!target || !target.demo) return bad(403, "only demo personas can be impersonated");
      return json({ member: target }, { headers: { "set-cookie": sessionCookie(secret, target.id) } });
    }

    // A shareable link straight into a demo persona's view: /demo?as=<id> or /demo?name=Bảo
    if (p === "/api/demo/open") {
      const id = url.searchParams.get("as");
      const name = url.searchParams.get("name");
      const row = (id
        ? ledger.db.query("SELECT id FROM members WHERE demo = 1 AND id = ?").get(id)
        : name
          ? ledger.db.query("SELECT id FROM members WHERE demo = 1 AND display_name = ? LIMIT 1").get(name)
          : ledger.db.query("SELECT id FROM members WHERE demo = 1 ORDER BY created_at LIMIT 1").get()) as { id: string } | null;
      if (!row) return bad(404, "no such demo persona");
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": sessionCookie(secret, row.id) } });
    }

    // Public numbers for the landing page: what is on Walrus now, and the latest live eval.
    if (p === "/api/public") {
      const id = await app.backend.identity().catch(() => null);
      const stats = ledger.stats() as any;
      return json({
        memory: app.backend.kind,
        accountId: id?.accountId ?? null,
        agentId: id?.agentId ?? null,
        model: app.llm.label,
        memoriesOnWalrus: stats.memoriesOnWalrus,
        peopleWithTenPlus: (stats.perMember as any[]).filter((m) => m.stored >= 10).length,
        sampleBlob: (ledger.db.query("SELECT blob_id FROM memories WHERE status = 'done' AND blob_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get() as any)?.blob_id ?? null,
        eval: latestEval(),
      });
    }

    if (p === "/api/demo/personas") {
      const rows = ledger.db.query("SELECT id, display_name FROM members WHERE demo = 1 ORDER BY created_at").all() as any[];
      const demoGroup = ledger.db.query("SELECT id, name FROM groups WHERE demo = 1 ORDER BY created_at LIMIT 1").get() as any;
      return json({ personas: rows.map((r) => ({ id: r.id, name: r.display_name })), group: demoGroup ?? null });
    }

    const member = me(req);
    if (!member) return bad(401, "no session");

    if (p === "/api/me") {
      return json({ member, groups: ledger.groupsOf(member.id).map((g) => groupView(g.id)) });
    }

    if (p === "/api/groups" && req.method === "POST") {
      const b = await body<{ name?: string }>(req);
      const name = (b.name ?? "").trim().slice(0, 60) || `${member.displayName}'s table`;
      const g = ledger.upsertGroup("web", newId(), name);
      ledger.addToGroup(g.id, member.id);
      return json({ group: groupView(g.id) });
    }

    if (p === "/api/groups/join" && req.method === "POST") {
      const b = await body<{ code?: string }>(req);
      const g = b.code ? ledger.groupByInvite(b.code) : null;
      if (!g) return bad(404, "no table with that code");
      ledger.addToGroup(g.id, member.id);
      return json({ group: groupView(g.id) });
    }

    const gm = /^\/api\/groups\/([^/]+)(\/[a-z]+)?$/.exec(p);
    if (gm) {
      const groupId = gm[1];
      const g = ledger.group(groupId);
      if (!g || !ledger.isMember(groupId, member.id)) return bad(404, "not your table");
      const sub = gm[2] ?? "";
      if (sub === "" && req.method === "GET") {
        return json({ group: groupView(groupId), messages: ledger.messages("group", groupId) });
      }
      if (sub === "/messages" && req.method === "POST") {
        const b = await body<{ text?: string }>(req);
        const text = (b.text ?? "").trim().slice(0, 2000);
        if (!text) return bad(400, "empty");
        const out = await engine.handle({ channel: "web", roomType: "group", roomId: groupId, memberId: member.id, text, addressed: /^@?tact\b/i.test(text) });
        return json({ out: out.filter((o) => o.roomType === "group" || o.roomId === member.id), messages: ledger.messages("group", groupId) });
      }
      if (sub === "/mode" && req.method === "POST") {
        const b = await body<{ mode?: string }>(req);
        engine.setMode(groupId, b.mode === "off" ? "off" : "tact");
        return json({ group: groupView(groupId) });
      }
      if (sub === "/memory") {
        const r = await memory.readFacts({ type: "group", id: groupId }, { fresh: url.searchParams.has("fresh") });
        return json({
          facts: r.facts.map(publicFactView), venues: venuesFrom(r.facts).map((v) => ({ name: v.name, area: v.area, price: v.price, cuisine: v.cuisine, blobId: v.fact.blobId })),
          rows: memoryRows("group", groupId), readMs: r.ms, failed: r.failed,
        });
      }
      return bad(404, "unknown");
    }

    if (p === "/api/dm" && req.method === "GET") {
      return json({ messages: ledger.messages("dm", member.id) });
    }
    if (p === "/api/dm" && req.method === "POST") {
      const b = await body<{ text?: string }>(req);
      const text = (b.text ?? "").trim().slice(0, 2000);
      if (!text) return bad(400, "empty");
      await engine.handle({ channel: "web", roomType: "dm", roomId: member.id, memberId: member.id, text });
      return json({ messages: ledger.messages("dm", member.id) });
    }

    if (p === "/api/memory/me") {
      const r = await memory.readFacts({ type: "member", id: member.id }, { fresh: url.searchParams.has("fresh") });
      return json({ facts: r.facts.map(publicFactView), rows: memoryRows("member", member.id), readMs: r.ms, failed: r.failed, error: r.error });
    }

    if (p === "/api/memory/tier" && req.method === "POST") {
      const b = await body<{ key?: string; tier?: Tier }>(req);
      if (!b.key || !b.tier || !["private", "discreet", "shared"].includes(b.tier)) return bad(400, "key and tier required");
      const r = await memory.readFacts({ type: "member", id: member.id }, { fresh: true });
      const f = r.facts.find((x) => x.key === b.key);
      if (!f) return bad(404, "no such memory");
      await memory.writeFact({ type: "member", id: member.id }, { ...f, tier: b.tier, at: new Date().toISOString(), quote: undefined });
      return json({ ok: true });
    }

    if (p === "/api/memory/forget" && req.method === "POST") {
      const b = await body<{ key?: string }>(req);
      const r = await memory.readFacts({ type: "member", id: member.id }, { fresh: true });
      const f = r.facts.find((x) => x.key === b.key);
      if (!f) return bad(404, "no such memory");
      await memory.writeFact({ type: "member", id: member.id }, { ...f, retract: true, text: `Retracted: ${f.text}`, at: new Date().toISOString(), quote: undefined });
      return json({ ok: true });
    }

    const pm = /^\/api\/plans\/([^/]+)$/.exec(p);
    if (pm) {
      const plan = ledger.plan(pm[1]);
      if (!plan || !ledger.isMember(plan.group_id, member.id)) return bad(404, "not found");
      const d = JSON.parse(plan.decision) as StoredPlan;
      // Everyone sees the public skeleton; each person sees only their own private influences.
      const dedupe = <T extends { detail: string; you?: string }>(xs: T[], key: (x: T) => string) => xs.filter((x, i) => xs.findIndex((y) => key(y) === key(x)) === i);
      const chosen = d.choice?.slug;
      const mine = dedupe(d.influences.filter((i) => i.memberId === member.id && (i.effect !== "boosted" || i.venue === chosen)), (x) => x.you ?? x.detail);
      // Public reasons are the shared memories that shaped the place actually chosen.
      const publicInfluences = dedupe(d.influences.filter((i) => i.tier === "shared" && i.memberId !== member.id && (!i.venue || i.venue === chosen)), (x) => x.detail);
      return json({
        id: plan.id, request: plan.request, createdAt: plan.created_at, mode: plan.mode,
        choice: d.choice, alternatives: d.alternatives,
        ruledOut: d.ruledOut.map((r) => ({ name: r.name })),
        attendees: d.attendees.map((a) => ({ name: a.name, readOk: a.readOk })),
        memoriesConsulted: d.memoriesConsulted, readMs: d.readMs, dayConflict: d.dayConflict ? { day: d.dayConflict.day, alternativeDay: d.dayConflict.alternativeDay, count: d.dayConflict.busyMemberIds.length } : null,
        mine, publicInfluences,
      });
    }

    if (p === "/api/shield") {
      return json({ entries: ledger.shieldFor(member.id).map((s) => ({ ...s, group: ledger.group(s.group_id)?.name })) });
    }

    if (p === "/api/evidence") {
      const id = await app.backend.identity().catch(() => null);
      return json({ identity: id, stats: ledger.stats(), memoryMode: app.backend.kind, llm: app.llm.label });
    }

    return bad(404, "unknown endpoint");
  };
}

/** The newest docs/evidence/eval-*-live.json summary, so the landing page shows measured numbers, not copy. */
function latestEval(): unknown {
  try {
    const dir = join(import.meta.dir, "..", "..", "docs", "evidence");
    const file = readdirSync(dir).filter((f) => /^eval-.*-live\.json$/.test(f)).sort().pop();
    if (!file) return null;
    const d = JSON.parse(readFileSync(join(dir, file), "utf8"));
    return { when: d.summary.when, source: d.summary.source, model: d.summary.model, people: d.summary.people, places: d.summary.places, plans: d.plans.length, probes: d.probes.length, totals: d.summary.totals, example: d.probes.find((x: any) => /allergic to anything/i.test(x.probe)) ?? null };
  } catch {
    return null;
  }
}
