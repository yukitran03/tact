import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

// ── types ──────────────────────────────────────────────────────────
type Tier = "private" | "discreet" | "shared";
interface Member { id: string; displayName: string; demo: boolean }
interface GroupView { id: string; name: string; inviteCode: string; demo: boolean; mode: "tact" | "off"; members: { id: string; name: string; demo: boolean }[] }
interface Msg { id: string; roomType: "group" | "dm"; roomId: string; memberId: string | null; role: "user" | "bot"; text: string; createdAt: string; meta?: any }
interface FactView { kind: string; tier: Tier; key: string; text: string; attrs: Record<string, string>; blobId?: string; origin?: "walrus" | "pending"; at: string }
interface Row { id: string; kind: string; tier: Tier; key: string; status: string; blobId: string | null; error: string | null; createdAt: string }
interface Health { memory: { mode: string; ok: boolean; detail: string }; llm: { label: string; ok: boolean; detail: string }; identity: { accountId: string; agentId: string } | null }
type Room = { type: "group"; id: string } | { type: "dm" };

// ── api ────────────────────────────────────────────────────────────
async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
  return data as T;
}

// ── helpers ────────────────────────────────────────────────────────
const PALETTE = ["#0f6e6a", "#6a4bd8", "#c2412d", "#2f7d4f", "#9a6512", "#3a5ba0", "#b0367a", "#4b6b2a"];
function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const initials = (name: string) => name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const Avatar = ({ id, name, size }: { id: string; name: string; size?: "lg" }) => (
  <span class={`avatar ${size ?? ""}`} style={{ background: colorFor(id) }} title={name}>{initials(name)}</span>
);
const walruscan = (blob: string) => `https://walruscan.com/mainnet/blob/${blob}`;
const shortBlob = (b: string) => `${b.slice(0, 6)}…${b.slice(-4)}`;
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const TIER_NAME: Record<Tier, string> = { shared: "Shared", discreet: "Discreet", private: "Private" };
const TIER_HELP: Record<Tier, string> = {
  shared: "Can be mentioned in the group",
  discreet: "Used for group plans, never said out loud",
  private: "Only used when you talk to Tact",
};

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
/** Tiny, safe markdown: bold, italic, code, bullets, line breaks. Input is escaped first. */
function md(text: string) {
  const lines = escapeHtml(text).split("\n");
  const out: string[] = [];
  let list: string[] = [];
  const inline = (s: string) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?:]|$)/g, "$1<i>$2</i>");
  const flush = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`); list = []; } };
  for (const l of lines) {
    const m = /^\s*(?:•|-|\d+\.)\s+(.*)$/.exec(l);
    if (m && !/^\s*\d+\.\s/.test(l)) { list.push(m[1]); continue; }
    flush();
    if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  flush();
  return { __html: out.join("") };
}

// ── icons ──────────────────────────────────────────────────────────
const Icon = {
  mark: (p: { color?: string }) => (
    <svg viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="6" width="56" height="44" rx="14" fill={p.color ?? "var(--accent)"} /><path d="M18 50 L14 60 L28 50 Z" fill={p.color ?? "var(--accent)"} /><circle cx="32" cy="24" r="6" fill="var(--bg)" /><rect x="29" y="27" width="6" height="11" rx="3" fill="var(--bg)" /></svg>
  ),
  botMark: () => (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="9" r="3" fill="#fff" /><rect x="10.8" y="10.5" width="2.4" height="6" rx="1.2" fill="#fff" /></svg>
  ),
  send: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 12l16-8-6 16-2-6-8-2z" fill="currentColor" /></svg>),
  lock: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="2.5" stroke="currentColor" stroke-width="2" /><path d="M8 10V8a4 4 0 118 0v2" stroke="currentColor" stroke-width="2" /></svg>),
  shield: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>),
  table: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" /><circle cx="12" cy="3.5" r="1.6" fill="currentColor" /><circle cx="20.5" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="20.5" r="1.6" fill="currentColor" /><circle cx="3.5" cy="12" r="1.6" fill="currentColor" /></svg>),
  db: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="6" rx="7" ry="3" stroke="currentColor" stroke-width="2" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" stroke="currentColor" stroke-width="2" /></svg>),
  receipt: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /><path d="M9 8h6M9 12h6" stroke="currentColor" stroke-width="2" /></svg>),
  check: () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>),
  x: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>),
  plus: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>),
  chat: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v11H9l-5 4V5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>),
  list: () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 6h14M5 12h14M5 18h9" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>),
  sun: () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>),
};

// ── theme ──────────────────────────────────────────────────────────
function useTheme() {
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem("tact-theme") ?? "auto"; } catch { return "auto"; } });
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("tact-theme", theme); } catch { /* private mode */ }
  }, [theme]);
  const cycle = () => setTheme((t) => (t === "auto" ? "dark" : t === "dark" ? "light" : "auto"));
  return { theme, cycle };
}

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2600); }, []);
  const node = msg ? <div class="toast" role="status">{msg}</div> : null;
  return { show, node };
}

// ── landing ────────────────────────────────────────────────────────
interface PublicInfo {
  memory: string;
  accountId: string | null;
  agentId: string | null;
  model: string;
  memoriesOnWalrus: number;
  peopleWithTenPlus: number;
  sampleBlob: string | null;
  eval: null | {
    when: string; source: string; model: string | null; people: number; places: number; plans: number; probes: number;
    totals: { off: { violations: number; questions: number }; naive: { violations: number; plans: number; probes: number; probeLeaks: number }; tact: { violations: number; plans: number; probes: number; probeLeaks: number } };
    example: { probe: string; tact: { text: string }; naive: { text: string } | null } | null;
  };
}

const short = (id: string, a = 6, b = 4) => `${id.slice(0, a)}…${id.slice(-b)}`;

function TwoViews() {
  return (
    <div class="views" aria-label="The same Friday plan, seen by the group and by Bảo">
      <div class="view">
        <div class="view-head"><Icon.table /> In the group</div>
        <div class="view-body">
          <div class="vb-msg"><span class="avatar sm" style={{ background: "#2f6f4f" }}>C</span><div class="vb-bubble">Where should we eat Friday?</div></div>
          <div class="vb-plan">
            <div class="vb-kicker">Tact's pick</div>
            <div class="vb-venue">Bánh Mì Chay Hòa</div>
            <div class="vb-meta">Binh Thanh · ~35k/person · works for all 4</div>
            <div class="vb-chips"><span class="chip ok"><Icon.db /> Read from Walrus</span><span class="chip discreet"><Icon.shield /> 0 private details shared</span></div>
            <p class="vb-note">8 other places didn't work for everyone. The reasons stay private.</p>
          </div>
        </div>
      </div>
      <div class="view private">
        <div class="view-head"><Icon.lock /> Only Bảo sees</div>
        <div class="view-body">
          <div class="vb-msg me"><div class="vb-bubble me">Mình dị ứng tôm cua, đừng nói ai nhé.</div></div>
          <div class="vb-saved"><span>Allergic to shellfish</span><span class="chip discreet">Discreet</span><span class="chip blob">7thUbv…CtDk</span></div>
          <div class="vb-shield">
            <div class="vb-kicker discreet">About Friday's plan</div>
            Ốc Đào Corner serves shellfish, and you're allergic to it. The group only heard that it didn't work for everyone.
          </div>
        </div>
      </div>
    </div>
  );
}

function Landing({ onSession, health }: { onSession: () => void; health: Health | null }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [demo, setDemo] = useState<{ personas: { id: string; name: string }[] } | null>(null);
  const { theme, cycle } = useTheme();
  useEffect(() => {
    api<PublicInfo>("/api/public").then(setInfo).catch(() => setInfo(null));
    api("/api/demo/personas").then(setDemo).catch(() => setDemo(null));
  }, []);

  const start = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try { await api("/api/session", { body: { name } }); onSession(); } finally { setBusy(false); }
  };
  const openDemo = async (memberId?: string) => {
    const id = memberId ?? demo?.personas[0]?.id;
    if (!id) return;
    setBusy(true);
    try { await api("/api/demo/as", { body: { memberId: id } }); onSession(); } finally { setBusy(false); }
  };

  const ev = info?.eval;
  const t = ev?.totals;
  const onWalrus = info?.memory === "walrus";

  return (
    <div class="lp">
      <header class="lp-nav">
        <a class="brand" href="/" aria-label="Tact home"><Icon.mark />Tact</a>
        <nav class="lp-links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#results">Results</a>
          <a href="#walrus">On Walrus</a>
        </nav>
        <div class="lp-nav-actions">
          <button class="icon-btn lg" onClick={cycle} aria-label={`Color theme: ${theme}`} title={`Theme: ${theme}`}><Icon.sun /></button>
          <button class="btn primary" onClick={() => openDemo()} disabled={busy || !demo?.personas.length}>Open the demo</button>
        </div>
      </header>

      <main>
        <section class="lp-hero">
          <div class="lp-hero-copy">
            <p class="eyebrow"><span class={`dot ${onWalrus ? "live" : "off"}`} />{onWalrus ? "Running on Walrus Memory mainnet" : "Group chat memory on Walrus"}</p>
            <h1>The group chat bot that remembers everyone and tells no one.</h1>
            <p class="lede">
              Tell Tact privately what you can't eat, what you can spend and which days you're busy.
              When your group asks where to go, it picks a place that works for everyone and never says why.
            </p>
            <div class="cta-row">
              <button class="btn primary lg" onClick={() => openDemo()} disabled={busy || !demo?.personas.length}>Open the live demo table</button>
              <a class="btn lg" href="#start">Start your own table</a>
            </div>
            <dl class="proof-row">
              <div><dt>{info ? info.memoriesOnWalrus : "…"}</dt><dd>memories stored as encrypted blobs on Walrus</dd></div>
              <div><dt>{t ? `${t.tact.probeLeaks} of ${t.tact.probes}` : "…"}</dt><dd>nosy questions that leaked a private detail</dd></div>
              <div><dt>{t ? t.tact.violations : "…"}</dt><dd>plans that broke someone's allergy, diet or budget</dd></div>
            </dl>
          </div>
          <TwoViews />
        </section>

        <section class="lp-problem" aria-labelledby="problem-h">
          <h2 id="problem-h" class="sr-only">The problem</h2>
          <div class="problem-grid">
            <div><b>Group chats repeat themselves.</b><span>Every Friday someone asks who is vegetarian again, and the person with an allergy has to say it in front of everyone.</span></div>
            <div><b>Memory bots overshare.</b><span>Put every memory in one prompt and the bot repeats private details the moment someone asks.</span></div>
            <div><b>Big assistants opt out.</b><span>ChatGPT group chats did not use personal memory. Meta AI keeps memory to one-to-one chats.</span></div>
          </div>
        </section>

        <section id="how" class="lp-section" aria-labelledby="how-h">
          <div class="section-head">
            <p class="kicker">How it works</p>
            <h2 id="how-h">One private chat per person. One shared table.</h2>
          </div>
          <ol class="steps-grid">
            <li><span class="step-ico"><Icon.lock /></span><b>Tell Tact privately</b><span>“Allergic to shrimp”, “max 80k”, “busy Thursdays”. Each is saved as discreet by default.</span></li>
            <li><span class="step-ico"><Icon.db /></span><b>It lands on Walrus</b><span>One SEAL-encrypted blob per fact, in a namespace that belongs to you alone.</span></li>
            <li><span class="step-ico"><Icon.table /></span><b>The group asks</b><span>Tact reads everyone's memory in parallel and plans in plain code: allergies and diets veto, likes score.</span></li>
            <li><span class="step-ico"><Icon.shield /></span><b>The group gets the answer</b><span>The group hears the pick. Each person gets a private note on how their own memories were used.</span></li>
          </ol>
        </section>

        <section id="results" class="lp-section" aria-labelledby="results-h">
          <div class="section-head">
            <p class="kicker">Results</p>
            <h2 id="results-h">Same people, same places, three bots.</h2>
            <p class="section-sub">{ev ? `${ev.people} people, ${ev.places} places, ${ev.plans} plan requests and ${ev.probes} nosy questions, with memories read from Walrus mainnet.` : "Memories read from Walrus mainnet."}</p>
          </div>
          <div class="table-wrap">
            <table class="compare">
              <thead>
                <tr><th scope="col"><span class="sr-only">Measure</span></th><th scope="col">Memory off</th><th scope="col">Typical memory bot</th><th scope="col" class="us">Tact</th></tr>
              </thead>
              <tbody>
                <tr><th scope="row">Allergy, diet or budget violations</th><td>{t ? t.off.violations : "…"}</td><td>{t ? t.naive.violations : "…"}</td><td class="us">{t ? t.tact.violations : "…"}</td></tr>
                <tr><th scope="row">Questions asked again before planning</th><td>{t ? t.off.questions : "…"}</td><td>0</td><td class="us">0</td></tr>
                <tr><th scope="row">Nosy questions that leaked</th><td class="na">knows nothing</td><td class="bad">{t ? `${t.naive.probeLeaks} of ${t.naive.probes}` : "…"}</td><td class="us">{t ? `${t.tact.probeLeaks} of ${t.tact.probes}` : "…"}</td></tr>
              </tbody>
            </table>
          </div>
          {ev?.example?.naive ? (
            <div class="probe">
              <div class="probe-q"><span class="avatar sm" style={{ background: "#2f6f4f" }}>C</span>“{ev.example.probe}”</div>
              <div class="probe-a bad"><span class="probe-label"><Icon.x /> Typical memory bot</span>{ev.example.naive.text.trim()}</div>
              <div class="probe-a good"><span class="probe-label"><Icon.check /> Tact</span>{ev.example.tact.text.trim()}</div>
            </div>
          ) : null}
          <p class="footnote">
            The typical memory bot is the same model with the same memories, all placed in one prompt. A leak is any private term (an allergen, a diet, a budget figure, a home area) found in text the group can see.
            {ev ? ` Model: ${ev.model ?? "n/a"}. Measured ${new Date(ev.when).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.` : ""} Reproduce with <code>bun run eval --live</code>.
          </p>
        </section>

        <section id="tiers" class="lp-section" aria-labelledby="tiers-h">
          <div class="section-head">
            <p class="kicker">Privacy</p>
            <h2 id="tiers-h">Every memory has a tier, and code enforces it.</h2>
            <p class="section-sub">The model that writes group messages never sees a discreet fact. Every group message is also scanned for anything a discreet fact implies, in English and Vietnamese.</p>
          </div>
          <div class="tier-grid">
            <div class="tier discreet"><span class="chip discreet">Discreet</span><b>Used to decide, never said.</b><span>The default for allergies, diets, budgets, home area and busy days.</span></div>
            <div class="tier shared"><span class="chip shared">Shared</span><b>Fine to mention in the group.</b><span>Likes, and anything you said out loud in the group yourself.</span></div>
            <div class="tier private"><span class="chip private">Private</span><b>Only for your own chat.</b><span>Never used for a group plan. Mark anything “don't use this”.</span></div>
          </div>
        </section>

        <section id="walrus" class="lp-section split" aria-labelledby="walrus-h">
          <div>
            <p class="kicker">On Walrus</p>
            <h2 id="walrus-h">Wipe the server and Tact still remembers.</h2>
            <ul class="facts">
              <li><Icon.check /><span>One namespace per person and one per table, with ids hashed because namespace names are public on-chain.</span></li>
              <li><Icon.check /><span>Each fact is a readable sentence plus a small tag block, encrypted with SEAL into its own blob.</span></li>
              <li><Icon.check /><span>Tact's database keeps job ids and blob ids, never the memory text, so every plan is rebuilt from Walrus.</span></li>
              <li><Icon.check /><span>Corrections supersede older facts. A retraction is written instead of a silent edit.</span></li>
            </ul>
          </div>
          <div class="receipt-card" aria-label="Live account details">
            <div class="rc-row"><span>Network</span><b>{onWalrus ? "Walrus mainnet" : "Offline demo store"}</b></div>
            <div class="rc-row"><span>Account</span>{info?.accountId ? <a class="mono" href={`https://suiscan.xyz/mainnet/object/${info.accountId}`} target="_blank" rel="noreferrer">{short(info.accountId, 8, 6)}</a> : <b>…</b>}</div>
            <div class="rc-row"><span>Delegate key</span><b class="mono">{info?.agentId ? short(info.agentId, 8, 6) : "…"}</b></div>
            <div class="rc-row"><span>Latest blob</span>{info?.sampleBlob ? <a class="mono" href={`https://walruscan.com/mainnet/blob/${info.sampleBlob}`} target="_blank" rel="noreferrer">{short(info.sampleBlob, 8, 6)}</a> : <b>…</b>}</div>
            <div class="rc-row"><span>People with 10+ memories</span><b>{info ? info.peopleWithTenPlus : "…"}</b></div>
            <div class="rc-row"><span>Model</span><b>{info?.model ?? health?.llm.label ?? "…"}</b></div>
          </div>
        </section>

        <section id="start" class="lp-cta" aria-labelledby="start-h">
          <h2 id="start-h">Try it with your own group.</h2>
          <p>Start a table, share the six-letter code, and tell Tact your constraints in a private chat.</p>
          <form class="start-panel" onSubmit={start}>
            <label class="sr-only" for="start-name">Your name</label>
            <input id="start-name" class="input lg" placeholder="Your name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autocomplete="given-name" />
            <button class="btn primary lg" type="submit" disabled={busy || !name.trim()}>Start a table</button>
          </form>
          {demo?.personas.length ? (
            <p class="cta-alt">Or look through the demo table as {demo.personas.map((p, i) => (
              <span key={p.id}>{i ? (i === demo.personas.length - 1 ? " or " : ", ") : ""}<button class="link" onClick={() => openDemo(p.id)}>{p.name}</button></span>
            ))}. Demo people are labelled; their memories are real blobs on mainnet.</p>
          ) : null}
        </section>
      </main>

      <footer class="lp-foot">
        <span class="brand sm"><Icon.mark />Tact</span>
        <span>Built for Walrus Sessions 8, Chatbots That Remember.</span>
        <span class="faint">Open source, MIT.</span>
      </footer>
    </div>
  );
}

// ── messages ───────────────────────────────────────────────────────
function PlanCard({ m, onReceipt }: { m: Msg; onReceipt: (id: string) => void }) {
  const meta = m.meta ?? {};
  if (meta.mode === "off") {
    return (
      <div class="plan-card off">
        <div class="pc-top">
          <div class="pc-kicker"><Icon.x /> Memory off</div>
          <div class="pc-venue">{meta.venue ?? "No pick"}</div>
          <div class="pc-meta">A bot without memory picks blind, then has to ask everyone again.</div>
        </div>
        <div class="pc-text md" dangerouslySetInnerHTML={md(m.text)} />
        <div class="pc-badges">
          <span class="chip danger">{meta.violations ?? 0} constraint{meta.violations === 1 ? "" : "s"} broken</span>
          <span class="chip neutral">{meta.questionsAsked ?? 0} questions re-asked</span>
        </div>
      </div>
    );
  }
  const choice = meta.choice;
  return (
    <div class="plan-card">
      <div class="pc-top">
        <div class="pc-kicker"><Icon.table /> Tact's pick</div>
        <div class="pc-venue">{choice?.name ?? "No place fits yet"}</div>
        {choice ? <div class="pc-meta">{[choice.area, choice.price ? `~${choice.price}/person` : null, meta.unreadable?.length ? `checked ${meta.people - meta.unreadable.length} of ${meta.people}` : `works for all ${meta.people}`].filter(Boolean).join(" · ")}</div> : null}
      </div>
      <div class="pc-text md" dangerouslySetInnerHTML={md(m.text)} />
      <div class="pc-badges">
        <span class="chip ok"><Icon.db /> {meta.memoriesConsulted} memories read{meta.readMs ? ` · ${(meta.readMs / 1000).toFixed(1)}s` : ""}</span>
        {meta.ruledOut ? <span class="chip neutral">{meta.ruledOut} ruled out · reasons private</span> : null}
        <span class="chip discreet"><Icon.shield /> 0 private details shared</span>
        {meta.leakBlocked ? <span class="chip danger" title="The model's draft mentioned something discreet; Tact replaced it">shield blocked {meta.leakBlocked}</span> : null}
        {meta.unreadable?.length ? <span class="chip danger">couldn't read: {meta.unreadable.join(", ")}</span> : null}
      </div>
      {meta.planId ? <div class="pc-actions"><button class="btn sm" onClick={() => onReceipt(meta.planId)}><Icon.receipt /> Receipt</button></div> : null}
    </div>
  );
}

function SavedFacts({ facts }: { facts: FactView[] }) {
  return (
    <div class="saved-facts">
      {facts.map((f) => (
        <div class="saved-fact" key={f.key}><span>{f.text}</span><span class={`chip ${f.tier}`}>{TIER_NAME[f.tier]}</span></div>
      ))}
    </div>
  );
}

function MessageView({ m, meId, names, onReceipt }: { m: Msg; meId: string; names: Map<string, string>; onReceipt: (id: string) => void }) {
  if (m.role === "bot") {
    const t = m.meta?.type;
    return (
      <div class="msg bot">
        <span class="bot-mark"><Icon.botMark /></span>
        <div class="stack">
          {t === "plan" ? <PlanCard m={m} onReceipt={onReceipt} /> : t === "shield-note" ? (
            <div class="shield-note"><div class="k"><Icon.lock /> Only you can see this</div><div class="md" dangerouslySetInnerHTML={md(m.text)} /></div>
          ) : (
            <div class="bubble md">
              <div dangerouslySetInnerHTML={md(t === "remembered" ? m.text.split("\n")[0] : m.text)} />
              {t === "remembered" && m.meta?.facts ? <SavedFacts facts={m.meta.facts} /> : null}
            </div>
          )}
          <span class="time">{timeOf(m.createdAt)}</span>
        </div>
      </div>
    );
  }
  const mine = m.memberId === meId;
  const name = names.get(m.memberId ?? "") ?? "Someone";
  return (
    <div class={`msg ${mine ? "me" : "them"}`}>
      {!mine ? <Avatar id={m.memberId ?? "x"} name={name} /> : null}
      <div class="stack">
        {!mine ? <span class="who">{name}</span> : null}
        <div class="bubble md" dangerouslySetInnerHTML={md(m.text)} />
        <span class="time">{timeOf(m.createdAt)}</span>
      </div>
    </div>
  );
}

function Composer({ placeholder, chips, onSend, busy, hint }: { placeholder: string; chips: string[]; onSend: (t: string) => Promise<void>; busy: boolean; hint: preact.ComponentChildren }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    await onSend(t);
    ref.current?.focus();
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);
  return (
    <div class="composer-wrap">
      <div class="chips">{chips.map((c) => <button key={c} onClick={() => { setText(c); ref.current?.focus(); }}>{c}</button>)}</div>
      <div class="composer">
        <textarea ref={ref} rows={1} value={text} placeholder={placeholder} aria-label={placeholder}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button class="send" onClick={send} disabled={busy || !text.trim()} aria-label="Send">{busy ? <span class="spin" /> : <Icon.send />}</button>
      </div>
      <div class="composer-hint">{hint}</div>
    </div>
  );
}

// ── inspector ──────────────────────────────────────────────────────
function StatusChip({ row, fact }: { row?: Row; fact?: FactView }) {
  const blob = fact?.blobId ?? row?.blobId ?? null;
  if (row && (row.status === "queued" || row.status === "pending")) return <span class="chip neutral"><span class="spin" /> writing to Walrus</span>;
  if (row?.status === "failed") return <span class="chip danger" title={row.error ?? ""}>write failed</span>;
  if (blob) return <a class="chip blob" href={walruscan(blob)} target="_blank" rel="noreferrer" title={`Walrus blob ${blob}`}>{shortBlob(blob)} ↗</a>;
  return <span class="chip neutral">local</span>;
}

function MemoryPanel({ refreshKey, toast }: { refreshKey: number; toast: (m: string) => void }) {
  const [data, setData] = useState<{ facts: FactView[]; rows: Row[]; readMs: number; failed: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try { setData(await api(`/api/memory/me${fresh ? "?fresh=1" : ""}`)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [refreshKey]);
  const inflight = data?.rows.some((r) => r.status === "queued" || r.status === "pending");
  useEffect(() => {
    if (!inflight) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [inflight]);

  const setTier = async (f: FactView, tier: Tier) => {
    await api("/api/memory/tier", { body: { key: f.key, tier } });
    toast(`Now ${TIER_NAME[tier].toLowerCase()}. Writing to Walrus.`);
    await load(true);
  };
  const forget = async (f: FactView) => {
    if (!confirm(`Retract “${f.text}”? Tact stops using it. The encrypted blob stays on Walrus until its storage expires.`)) return;
    await api("/api/memory/forget", { body: { key: f.key } });
    toast("Retracted. A superseding memory is being written.");
    await load(true);
  };
  const rowFor = (f: FactView) => data?.rows.find((r) => r.key === f.key && (r.blobId === f.blobId || r.status !== "done"));
  const byTier = (t: Tier) => (data?.facts ?? []).filter((f) => f.tier === t);

  return (
    <div class="panel">
      <div class="explain">
        This is everything Tact remembers about <b>you</b>, read back live from your namespace on Walrus{data ? ` in ${(data.readMs / 1000).toFixed(1)}s` : ""}. Nobody else in your tables can see this list.
      </div>
      {data?.failed ? <div class="explain" style={{ color: "var(--danger)" }}>Walrus didn't answer this time; showing what was cached. Tact will not guess.</div> : null}
      {(["discreet", "shared", "private"] as Tier[]).map((tier) => byTier(tier).length ? (
        <div key={tier} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <h4><span>{TIER_NAME[tier]} · {byTier(tier).length}</span><span class="faint" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>{TIER_HELP[tier]}</span></h4>
          {byTier(tier).map((f) => (
            <div class="fact" key={f.key + (f.blobId ?? "")}>
              <div class="t">{f.text}</div>
              <div class="row">
                <select class={`tier-select ${f.tier}`} value={f.tier} onChange={(e) => setTier(f, (e.target as HTMLSelectElement).value as Tier)} aria-label="Who this memory reaches">
                  <option value="discreet">Discreet</option><option value="shared">Shared</option><option value="private">Private</option>
                </select>
                <StatusChip row={rowFor(f)} fact={f} />
                <span class="grow" />
                <button class="icon-btn" title="Retract" onClick={() => forget(f)}><Icon.x /></button>
              </div>
            </div>
          ))}
        </div>
      ) : null)}
      {data && !data.facts.length ? <div class="explain">Nothing yet. Open <b>Private with Tact</b> and tell it what you can't eat, your budget, or your area.</div> : null}
      <button class="btn sm" onClick={() => load(true)} disabled={loading}>{loading ? <span class="spin" /> : null} Re-read from Walrus</button>
    </div>
  );
}

function TablePanel({ groupId, refreshKey }: { groupId: string; refreshKey: number }) {
  const [data, setData] = useState<{ venues: { name: string; area?: string; price?: number; cuisine: string[]; blobId?: string }[]; facts: FactView[]; rows: Row[] } | null>(null);
  useEffect(() => { api(`/api/groups/${groupId}/memory`).then(setData).catch(() => setData(null)); }, [groupId, refreshKey]);
  const verdicts = (data?.facts ?? []).filter((f) => f.kind === "verdict");
  return (
    <div class="panel">
      <div class="explain">The table's <b>shared</b> memory: places and verdicts anyone here can see. What each person told Tact privately is never listed here.</div>
      <h4>Places · {data?.venues.length ?? 0}</h4>
      {data?.venues.map((v) => (
        <div class="venue-row" key={v.name}>
          <div><b>{v.name}</b><div class="muted" style={{ fontSize: "12px" }}>{[v.cuisine.join("/"), v.area, v.price ? `~${Math.round(v.price / 1000)}k` : null].filter(Boolean).join(" · ")}</div></div>
          {v.blobId ? <a class="chip blob" href={walruscan(v.blobId)} target="_blank" rel="noreferrer">{shortBlob(v.blobId)} ↗</a> : <span class="chip neutral"><span class="spin" /></span>}
        </div>
      ))}
      {verdicts.length ? <h4>Verdicts · {verdicts.length}</h4> : null}
      {verdicts.map((v) => <div class="fact" key={v.key}><div class="t">{v.text}</div></div>)}
    </div>
  );
}

function ReceiptPanel({ planId }: { planId: string | null }) {
  const [r, setR] = useState<any>(null);
  useEffect(() => { if (planId) api(`/api/plans/${planId}`).then(setR).catch(() => setR(null)); else setR(null); }, [planId]);
  if (!planId || !r) return <div class="panel"><div class="explain">Ask the table where to eat, then open a plan's <b>Receipt</b> to see exactly how memory shaped it.</div></div>;
  return (
    <div class="panel">
      <div class="explain">“{r.request}”</div>
      <div class="stat-grid">
        <div class="stat"><b>{r.memoriesConsulted}</b><span>memories read from Walrus</span></div>
        <div class="stat"><b>{(r.readMs / 1000).toFixed(1)}s</b><span>parallel recall, {r.attendees.length} people</span></div>
        <div class="stat"><b>{r.ruledOut.length}</b><span>places ruled out</span></div>
        <div class="stat"><b>{r.mine.length}</b><span>of your memories used</span></div>
      </div>
      <h4>Your part · only you see this</h4>
      {r.mine.length ? r.mine.map((i: any, k: number) => (
        <div class="receipt-row" key={k}>
          <span class={`eff ${i.effect}`}>{i.effect}</span>
          <div style={{ flex: 1 }}>
            <div>{i.you ?? i.detail}</div>
            <div class="row" style={{ display: "flex", gap: "6px", marginTop: "4px", flexWrap: "wrap" }}>
              <span class={`chip ${i.tier}`}>{TIER_NAME[i.tier as Tier]}</span>
              {i.blobId ? <a class="chip blob" href={walruscan(i.blobId)} target="_blank" rel="noreferrer">{shortBlob(i.blobId)} ↗</a> : null}
            </div>
          </div>
        </div>
      )) : <div class="explain">None of your memories changed this plan.</div>}
      <h4>Public reasons</h4>
      {r.publicInfluences.length ? r.publicInfluences.slice(0, 12).map((i: any, k: number) => (
        <div class="receipt-row" key={k}><span class={`eff ${i.effect}`}>{i.effect}</span><div>{i.detail}</div></div>
      )) : <div class="explain">Everything else that shaped this plan was discreet, so it stays with its owners.</div>}
      {r.ruledOut.length ? <><h4>Ruled out</h4><div class="explain">{r.ruledOut.map((x: any) => x.name).join(", ")}. The reasons stay private to the people they protect.</div></> : null}
    </div>
  );
}

function ShieldPanel({ refreshKey }: { refreshKey: number }) {
  const [entries, setEntries] = useState<any[]>([]);
  useEffect(() => { api("/api/shield").then((d) => setEntries(d.entries)).catch(() => setEntries([])); }, [refreshKey]);
  return (
    <div class="panel">
      <div class="explain">Every time one of your discreet memories changed a group decision, it's logged here and nowhere else. The group was told only that a place “didn't work for everyone”.</div>
      {entries.length ? entries.map((e) => (
        <div class="fact" key={e.id}>
          <div class="t">{e.detail}</div>
          <div class="row"><span class={`eff ${e.action}`} style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>{e.action}</span><span class="muted" style={{ fontSize: "12px" }}>{e.group} · {timeOf(e.created_at)}</span><span style={{ flex: 1 }} />{e.blob_id ? <a class="chip blob" href={walruscan(e.blob_id)} target="_blank" rel="noreferrer">{shortBlob(e.blob_id)} ↗</a> : null}</div>
        </div>
      )) : <div class="explain">Nothing withheld yet.</div>}
    </div>
  );
}

// ── shell ──────────────────────────────────────────────────────────
function Shell({ me, onLogout, health }: { me: Member; onLogout: () => void; health: Health | null }) {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"memory" | "table" | "receipt" | "shield">("memory");
  const [planId, setPlanId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [mobileView, setMobileView] = useState<"rooms" | "chat" | "inspector">("chat");
  const [modal, setModal] = useState<"new" | "join" | null>(null);
  const [personas, setPersonas] = useState<{ id: string; name: string }[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const { show: toast, node: toastNode } = useToast();
  const { theme, cycle } = useTheme();

  const loadMe = useCallback(async () => {
    const d = await api<{ groups: GroupView[] }>("/api/me");
    setGroups(d.groups);
    setRoom((r) => r ?? (d.groups[0] ? { type: "group", id: d.groups[0].id } : { type: "dm" }));
  }, []);
  useEffect(() => { void loadMe(); if (me.demo) api("/api/demo/personas").then((d) => setPersonas(d.personas)).catch(() => {}); }, [me.id]);

  const group = room?.type === "group" ? groups.find((g) => g.id === room.id) ?? null : null;
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const x of g.members) m.set(x.id, x.name);
    m.set(me.id, me.displayName);
    return m;
  }, [groups, me]);

  const loadRoom = useCallback(async () => {
    if (!room) return;
    if (room.type === "group") {
      const d = await api<{ group: GroupView; messages: Msg[] }>(`/api/groups/${room.id}`);
      setMessages(d.messages);
      setGroups((gs) => gs.map((g) => (g.id === d.group.id ? d.group : g)));
    } else {
      const d = await api<{ messages: Msg[] }>("/api/dm");
      setMessages(d.messages);
    }
  }, [room]);
  useEffect(() => { void loadRoom(); }, [room?.type, (room as any)?.id]);
  useEffect(() => {
    const t = setInterval(() => { if (!busy) void loadRoom(); }, 4000);
    return () => clearInterval(t);
  }, [loadRoom, busy]);
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [messages.length, busy]);
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.meta?.type === "plan" && m.meta?.planId);
    if (last) setPlanId(last.meta.planId);
  }, [messages]);

  const send = async (text: string) => {
    if (!room) return;
    setBusy(true);
    const optimistic: Msg = { id: `tmp-${Date.now()}`, roomType: room.type, roomId: room.type === "group" ? room.id : me.id, memberId: me.id, role: "user", text, createdAt: new Date().toISOString() };
    setMessages((ms) => [...ms, optimistic]);
    try {
      if (room.type === "group") {
        const d = await api<{ messages: Msg[]; out: any[] }>(`/api/groups/${room.id}/messages`, { body: { text } });
        setMessages(d.messages);
        const notes = d.out.filter((o) => o.roomType === "dm");
        if (notes.length) toast("Tact left you a private note about this plan.");
      } else {
        const d = await api<{ messages: Msg[] }>("/api/dm", { body: { text } });
        setMessages(d.messages);
      }
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(`Couldn't send: ${(err as Error).message}`);
      setMessages((ms) => ms.filter((m) => m.id !== optimistic.id));
    } finally {
      setBusy(false);
    }
  };

  const setMode = async (mode: "tact" | "off") => {
    if (!group) return;
    const d = await api<{ group: GroupView }>(`/api/groups/${group.id}/mode`, { body: { mode } });
    setGroups((gs) => gs.map((g) => (g.id === d.group.id ? d.group : g)));
    toast(mode === "off" ? "Memory off: Tact answers like a bot that forgets" : "Memory on");
  };

  const switchPersona = async (id: string) => {
    await api("/api/demo/as", { body: { memberId: id } });
    location.reload();
  };

  const openReceipt = (id: string) => { setPlanId(id); setTab("receipt"); setMobileView("inspector"); };

  const groupChips = ["Where should we eat Friday?", "Thứ 6 ăn gì mọi người?", "add place: ", "@tact what do you remember?"];
  const dmChips = ["Mình dị ứng tôm cua", "My budget is 120k max", "I live in District 7", "What do you know about me?", "why did you skip "];

  return (
    <div class={`shell view-${mobileView}`}>
      <aside class="sidebar">
        <div class="brand"><Icon.mark />Tact</div>
        <div class="side-section">
          <div class="side-title"><span>Tables</span>
            <span style={{ display: "flex", gap: "2px" }}>
              <button class="icon-btn" title="New table" onClick={() => setModal("new")}><Icon.plus /></button>
            </span>
          </div>
          {groups.map((g) => (
            <button key={g.id} class={`side-item ${room?.type === "group" && room.id === g.id ? "active" : ""}`} onClick={() => { setRoom({ type: "group", id: g.id }); setTab("table"); setMobileView("chat"); }}>
              <span class="room-ico"><Icon.table /></span>
              <span class="meta"><b>{g.name}</b><small>{g.members.length} people{g.demo ? " · demo" : ""}</small></span>
            </button>
          ))}
          <button class="side-item" onClick={() => setModal("join")}><span class="room-ico" style={{ background: "var(--bg-2)", color: "var(--muted)" }}><Icon.plus /></span><span class="meta"><b>Join with a code</b><small>Six letters from a friend</small></span></button>
        </div>
        <div class="side-section">
          <div class="side-title"><span>Private</span></div>
          <button class={`side-item ${room?.type === "dm" ? "active" : ""}`} onClick={() => { setRoom({ type: "dm" }); setTab("memory"); setMobileView("chat"); }}>
            <span class="room-ico dm"><Icon.lock /></span>
            <span class="meta"><b>Private with Tact</b><small>Only you can see this</small></span>
          </button>
        </div>
        <div class="side-foot">
          {me.demo && personas.length ? (
            <div class="persona-switch">
              <div style={{ fontSize: "12px", fontWeight: 700 }}>Demo persona. View the table as:</div>
              <div class="row">{personas.map((p) => <button key={p.id} class={p.id === me.id ? "on" : ""} onClick={() => switchPersona(p.id)}><Avatar id={p.id} name={p.name} />{p.name}</button>)}</div>
            </div>
          ) : null}
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Avatar id={me.id} name={me.displayName} />
            <div style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: "13.5px" }}>{me.displayName}</b>{me.demo ? <span class="chip neutral" style={{ marginLeft: "6px" }}>demo</span> : null}</div>
            <button class="icon-btn" title={`Theme: ${theme}`} onClick={cycle}><Icon.sun /></button>
            <button class="btn ghost sm" onClick={onLogout}>Leave</button>
          </div>
          <div class="status-line"><span class={`dot ${!health ? "off" : health.memory.ok ? "live" : "warn"}`} /><span>{!health ? "Connecting…" : health.memory.mode === "walrus" ? "Walrus Memory · mainnet" : "Mock memory (offline)"}</span>{health?.identity ? <a class="mono faint" href={`https://suiscan.xyz/mainnet/object/${health.identity.accountId}`} target="_blank" rel="noreferrer" title="MemWalAccount on Sui">{health.identity.accountId.slice(0, 6)}…{health.identity.accountId.slice(-4)}</a> : null}</div>
          <div class="status-line"><span class={`dot ${health?.llm.ok ? "live" : "off"}`} /><span class="mono">{health?.llm.label ?? "…"}</span></div>
        </div>
      </aside>

      <main class="main">
        <header class="room-head">
          {room?.type === "group" && group ? (
            <>
              <span class="room-ico"><Icon.table /></span>
              <div class="grow">
                <h2>{group.name}</h2>
                <div class="sub"><span class="avatars">{group.members.slice(0, 6).map((m) => <Avatar key={m.id} id={m.id} name={m.name} />)}</span>
                  <span>{group.members.length} people</span>
                  <button class="chip neutral" style={{ border: 0, cursor: "pointer" }} onClick={() => { navigator.clipboard?.writeText(group.inviteCode); toast(`Invite code ${group.inviteCode} copied`); }} title="Copy invite code">invite · <span class="mono">{group.inviteCode}</span></button>
                </div>
              </div>
              <div class="seg" role="group" aria-label="Memory mode">
                <button class={group.mode === "tact" ? "on" : ""} onClick={() => setMode("tact")}>Memory on</button>
                <button class={group.mode === "off" ? "on off" : ""} onClick={() => setMode("off")}>Off</button>
              </div>
            </>
          ) : (
            <>
              <span class="room-ico dm"><Icon.lock /></span>
              <div class="grow"><h2>Private with Tact</h2><div class="sub">Only you and Tact see this. Discreet things you say here shape group plans without ever being said there.</div></div>
            </>
          )}
        </header>
        <div class="feed" ref={feedRef}>
          {!room ? <div class="empty-room"><span class="spin" style={{ color: "var(--accent)" }} /></div> : messages.length === 0 ? (
            <div class="empty-room">
              {room?.type === "dm" ? (<><h3>Tell Tact what matters</h3><p>Allergies, diets, budget, the area you live in, days you're busy. It stays discreet: used for plans, never said in a group.</p></>)
                : (<><h3>A quiet table</h3><p>Add a few places with “add place: …”, then ask “where should we eat Friday?”. Invite friends with the code above.</p></>)}
            </div>
          ) : messages.map((m) => <MessageView key={m.id} m={m} meId={me.id} names={names} onReceipt={openReceipt} />)}
          {busy ? <div class="msg bot"><span class="bot-mark"><Icon.botMark /></span><div class="bubble"><span class="typing"><i /><i /><i /></span> <span class="muted" style={{ fontSize: "12.5px" }}>reading memory from Walrus…</span></div></div> : null}
        </div>
        <Composer
          placeholder={room?.type === "dm" ? "Tell Tact something private…" : "Message the table. Start with @tact to ask it anything"}
          chips={room?.type === "dm" ? dmChips : groupChips}
          onSend={send}
          busy={busy}
          hint={room?.type === "dm"
            ? <><Icon.lock /> Saved to your own Walrus Memory namespace, SEAL-encrypted.</>
            : <><Icon.shield /> Tact plans with everyone's memory but only says what's shared.</>}
        />
      </main>

      <aside class="inspector">
        <div class="tabs" role="tablist">
          <button class={tab === "memory" ? "on" : ""} onClick={() => setTab("memory")}><Icon.db /> Memory</button>
          {group ? <button class={tab === "table" ? "on" : ""} onClick={() => setTab("table")}><Icon.table /> Table</button> : null}
          <button class={tab === "receipt" ? "on" : ""} onClick={() => setTab("receipt")}><Icon.receipt /> Receipt</button>
          <button class={tab === "shield" ? "on" : ""} onClick={() => setTab("shield")}><Icon.shield /> Shield</button>
        </div>
        {tab === "memory" ? <MemoryPanel refreshKey={refreshKey} toast={toast} />
          : tab === "table" && group ? <TablePanel groupId={group.id} refreshKey={refreshKey} />
            : tab === "receipt" ? <ReceiptPanel planId={planId} />
              : <ShieldPanel refreshKey={refreshKey} />}
      </aside>

      <nav class="mobile-tabs">
        <button class={mobileView === "rooms" ? "on" : ""} onClick={() => setMobileView("rooms")}><Icon.list />Rooms</button>
        <button class={mobileView === "chat" ? "on" : ""} onClick={() => setMobileView("chat")}><Icon.chat />Chat</button>
        <button class={mobileView === "inspector" ? "on" : ""} onClick={() => setMobileView("inspector")}><Icon.db />Memory</button>
      </nav>

      {modal ? <TableModal kind={modal} onClose={() => setModal(null)} onDone={(g) => { setModal(null); setGroups((gs) => gs.some((x) => x.id === g.id) ? gs : [...gs, g]); setRoom({ type: "group", id: g.id }); }} /> : null}
      {toastNode}
    </div>
  );
}

function TableModal({ kind, onClose, onDone }: { kind: "new" | "join"; onClose: () => void; onDone: (g: GroupView) => void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    try {
      const d = kind === "new" ? await api<{ group: GroupView }>("/api/groups", { body: { name: v } }) : await api<{ group: GroupView }>("/api/groups/join", { body: { code: v } });
      onDone(d.group);
    } catch (e2) { setErr((e2 as Error).message); }
  };
  return (
    <div class="modal-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form class="modal" onSubmit={submit}>
        <h3>{kind === "new" ? "Start a table" : "Join a table"}</h3>
        <p class="muted" style={{ margin: 0 }}>{kind === "new" ? "A table is a group chat with shared memory. You'll get a six-letter code to invite friends." : "Paste the six-letter code a friend shared."}</p>
        <input class="input" autoFocus value={v} placeholder={kind === "new" ? "Friday dinner crew" : "ABC123"} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
        {err ? <div style={{ color: "var(--danger)", fontSize: "13px" }}>{err}</div> : null}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button type="button" class="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" class="btn primary" disabled={!v.trim()}>{kind === "new" ? "Create" : "Join"}</button>
        </div>
      </form>
    </div>
  );
}

function App() {
  const [me, setMe] = useState<Member | null | undefined>(undefined);
  const [health, setHealth] = useState<Health | null>(null);
  useTheme();
  const load = useCallback(async () => {
    try { const d = await api<{ member: Member }>("/api/me"); setMe(d.member); } catch { setMe(null); }
  }, []);
  useEffect(() => { void load(); api<Health>("/api/health").then(setHealth).catch(() => {}); }, []);
  if (me === undefined) return <div style={{ display: "grid", placeItems: "center", height: "100%" }}><span class="spin" style={{ color: "var(--accent)" }} /></div>;
  if (!me) return <Landing onSession={load} health={health} />;
  return <Shell me={me} health={health} onLogout={async () => { await api("/api/session/logout", { method: "POST" }); setMe(null); }} />;
}

render(<App />, document.getElementById("root")!);
