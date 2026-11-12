/*
 * Keystone on the phone: the part that thinks. No screen code here (that's index.html) and nothing Android-specific:
 * everything outside goes through `io`, which the Android app provides (and tests fake):
 *   io.http({ method, url, headers, body }) -> Promise<{ status, body }>   (the app's own network, so no browser limits)
 *   io.get(key) / io.set(key, value)                                       (kept on this phone only)
 *   io.confirm(title, lines) -> Promise<boolean>                           (a Yes/No card before anything is written)
 *
 * The phone talks straight to Homebase, Google (Calendar, Gmail drafts) and Gemini with the keys it got from
 * Keystone on the laptop when it was paired. Email is drafts only; anything that writes asks first.
 */
(function (root) {
  "use strict";

  const NOTE_PREFIX = "🧮 Estimating hub";
  const TZ = "America/Denver";
  const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const fmtPhone = (p) => {
    const d = digits(p);
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || "").trim();
  };

  function create(io) {
    const setup = () => {
      try { return JSON.parse(io.get("setup") || "null"); } catch { return null; }
    };
    const paired = () => !!setup()?.homebase?.token;

    async function json(req) {
      const r = await io.http(req);
      let j = {};
      try { j = r.body ? JSON.parse(r.body) : {}; } catch { j = {}; }
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: j, text: r.body || "" };
    }

    // ------------------------------------------------------------------ Homebase
    async function hb(method, path, body) {
      const s = setup();
      if (!s?.homebase?.token) throw new Error("This phone isn't connected to Keystone yet.");
      const headers = { Accept: "application/json", Authorization: `Bearer ${s.homebase.token}` };
      if (s.me?.email) headers["X-Acting-User-Email"] = s.me.email;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (method !== "GET") headers["Idempotency-Key"] = `phone:${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const r = await json({ method, url: `${s.homebase.url}/api/v1${path}`, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok || r.json.ok === false) {
        const e = r.json.error || {};
        throw new Error(r.status === 401 || r.status === 403 ? "Homebase didn't accept this phone's sign-in. Connect the phone again from the laptop." : `Homebase: ${r.status} ${e.message || e.code || ""}`.trim());
      }
      return r.json;
    }
    const ids = new Map();
    const brief = (p) => ({ jobNumber: Number(p.jobNumber), name: p.name || p.customerName || "", address: p.address || p.brief?.address || "", stage: p.stage || p.status || "" });
    async function findJobs(query) {
      const q = String(query || "").trim();
      const get = async (active) => (await hb("GET", `/projects?${new URLSearchParams({ ...(q ? { q } : { department: "reconstruction" }), active, limit: q ? "20" : "200" })}`)).projects || [];
      let rows = await get("1");
      if (!rows.length && q) rows = await get("0");
      for (const r of rows) ids.set(Number(r.jobNumber), r.id);
      return rows.filter((r) => /^\d+$/.test(String(r.jobNumber))).map(brief);
    }
    async function projectId(n) {
      if (ids.has(n)) return ids.get(n);
      await findJobs(String(n));
      if (!ids.has(n)) throw new Error(`Homebase has no job #${n}.`);
      return ids.get(n);
    }
    async function getJob(n) {
      const id = await projectId(Number(n));
      const r = await hb("GET", `/projects/${id}`);
      const p = r.project || r;
      const notes = await hb("GET", `/projects/${id}/notes`).then((x) => x.notes || []).catch(() => []);
      const contacts = (p.contacts || []).map((c) => ({ name: c.name || "", roles: (c.roles || []).join(", ") || (c.isPrimary ? "Primary" : ""), phone: fmtPhone(c.mobile || c.phone || ""), email: c.email || "", company: c.accountName || "" }));
      for (const a of [p.brief?.adjuster1, p.brief?.adjuster2]) if (a && typeof a === "object" && a.name && !contacts.some((c) => c.name === a.name)) contacts.push({ name: a.name, roles: "Adjuster", phone: fmtPhone(a.mobile || a.phone || ""), email: a.email || "", company: "" });
      return {
        ...brief(p),
        stageSince: p.dates?.stageChanged || "",
        people: p.people || {},
        carrier: typeof p.brief?.carrier === "object" && p.brief?.carrier ? p.brief.carrier.name || "" : p.brief?.carrier || "",
        claimNumber: p.brief?.claimNumber || "",
        proposalAmount: p.money?.proposalAmount ?? null,
        contractAmount: p.money?.contractAmount ?? null,
        contacts,
        recentNotes: notes.slice(0, 6).map((x) => ({ at: x.postedAt, author: x.author || "", body: String(x.body || "").slice(0, 500) })),
        intakeEmail: `office+${Number(n)}@forefrontteam.com`,
      };
    }
    async function addNote(n, body) {
      const id = await projectId(Number(n));
      await hb("POST", `/projects/${id}/notes`, { body, prefix: NOTE_PREFIX });
    }
    async function logCall(n, o) {
      const id = await projectId(Number(n));
      await hb("POST", `/projects/${id}/activity`, { kind: "call", direction: o.direction === "Inbound" ? "Inbound" : "Outbound", who: o.who || undefined, subject: String(o.subject || "Call").slice(0, 250), details: o.details || undefined });
    }

    // ------------------------------------------------------------------ Contacts
    /** Keystone's own contacts (a copy from the laptop, as of pairing) plus whatever Homebase knows. */
    async function findContact(query) {
      const q = String(query || "").trim().toLowerCase();
      if (q.length < 2) return [];
      const words = q.split(/\s+/);
      const mine = (setup()?.contacts || [])
        .filter((p) => {
          const hay = `${p.name} ${p.company || ""} ${(p.emails || []).join(" ")} ${(p.phones || []).join(" ")} ${(p.jobs || []).map((j) => `#${j.jobNumber} ${j.name}`).join(" ")}`.toLowerCase();
          return words.every((w) => hay.includes(w)) || (digits(q).length >= 4 && (p.phones || []).some((ph) => digits(ph).includes(digits(q))));
        })
        .slice(0, 8)
        .map((p) => ({ name: p.name, company: p.company || "", title: p.title || "", phones: (p.phones || []).map(fmtPhone), emails: p.emails || [], jobs: (p.jobs || []).map((j) => `#${j.jobNumber} ${j.name} (${j.role})`), from: "Keystone" }));
      let theirs = [];
      if (q.length >= 3) {
        theirs = await hb("GET", `/contacts?${new URLSearchParams({ q })}`)
          .then((r) => (r.contacts || []).slice(0, 8).map((c) => ({ name: c.name || "", company: c.accountName || "", title: c.title || "", phones: (c.phones?.length ? c.phones.map((x) => x.number) : [c.mobile, c.phone]).filter(Boolean).map(fmtPhone), emails: c.email ? [c.email] : [], jobs: [], from: "Homebase" })))
          .catch(() => []);
      }
      const seen = new Set(mine.map((p) => p.name.toLowerCase()));
      return [...mine, ...theirs.filter((p) => !seen.has(p.name.toLowerCase()))];
    }

    // ------------------------------------------------------------------ Google (Calendar, Gmail drafts)
    let token = { value: "", until: 0 };
    async function googleToken() {
      const g = setup()?.google;
      if (!g?.refreshToken) throw new Error("Google isn't connected on this phone. Connect Gmail in Keystone on the laptop, then connect the phone again.");
      if (token.value && Date.now() < token.until) return token.value;
      const r = await json({ method: "POST", url: "https://oauth2.googleapis.com/token", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: "refresh_token" }).toString() });
      if (!r.ok || !r.json.access_token) throw new Error("Google didn't accept this phone's sign-in. Connect the phone again from the laptop.");
      token = { value: r.json.access_token, until: Date.now() + (Number(r.json.expires_in || 3000) - 120) * 1000 };
      return token.value;
    }
    async function google(method, url, body) {
      const r = await json({ method, url, headers: { Authorization: `Bearer ${await googleToken()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok) throw new Error(`Google: ${r.json?.error?.message || r.status}`);
      return r.json;
    }
    async function calendarList(start, end) {
      const q = new URLSearchParams({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "40" });
      const r = await google("GET", `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
      return (r.items || []).filter((e) => e.status !== "cancelled").map((e) => ({ title: e.summary || "(no title)", start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location || "", attendees: (e.attendees || []).map((a) => a.email) }));
    }
    async function calendarCreate(o) {
      const ev = { summary: o.title, location: o.location || undefined, description: o.description || undefined, start: { dateTime: o.start, timeZone: TZ }, end: { dateTime: o.end, timeZone: TZ }, attendees: (o.attendees || []).filter(Boolean).map((email) => ({ email })) };
      const r = await google("POST", `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${ev.attendees.length ? "all" : "none"}`, ev);
      return { link: r.htmlLink || "" };
    }
    const b64url = (s) => {
      const bytes = new TextEncoder().encode(s);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);
    async function gmailDraft(o) {
      const lines = [`To: ${(o.to || []).join(", ")}`];
      if (o.cc?.length) lines.push(`Cc: ${o.cc.join(", ")}`);
      if (o.jobNumber) lines.push(`Bcc: office+${Number(o.jobNumber)}@forefrontteam.com`);
      lines.push(`Subject: ${encWord(o.subject || "")}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", String(o.body || "").replace(/\r?\n/g, "\r\n"));
      await google("POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw: b64url(lines.join("\r\n")) } });
    }

    // ------------------------------------------------------------------ The tools Gemini can use
    const T = (name, description, properties, required, run) => ({ decl: { name, description, parametersJsonSchema: { type: "object", properties, required: required || [] } }, run });
    const S = { type: "string" }, N = { type: "number" };
    const tools = [
      T("find_jobs", "Search Homebase jobs by customer name, address or job number. An empty query lists every open reconstruction job.", { query: S }, [], (a) => findJobs(a.query)),
      T("get_job", "Everything about one job: stage, address, people and their phone numbers and emails, carrier and claim, amounts, the latest team notes.", { jobNumber: N }, ["jobNumber"], (a) => getJob(a.jobNumber)),
      T("find_contact", "Look someone up by name, company, phone or job. Searches Hunter's Keystone contacts and Homebase.", { query: S }, ["query"], (a) => findContact(a.query)),
      T("add_note", "Post a note on a job's Notes tab in Homebase (an update, something learned, a decision). Hunter is asked to confirm first.", { jobNumber: N, body: { type: "string", description: "The note, cleaned up into clear sentences, in Hunter's words. No greeting or signature." } }, ["jobNumber", "body"], async (a) => {
        if (!(await io.confirm(`Add this note to #${a.jobNumber} in Homebase?`, [a.body]))) return { done: false, reason: "Hunter said no." };
        await addNote(a.jobNumber, a.body);
        return { done: true };
      }),
      T("log_call", "Log a phone call on a job in Homebase. Hunter is asked to confirm first.", { jobNumber: N, who: { type: "string", description: "Who the call was with" }, direction: { type: "string", enum: ["Outbound", "Inbound"] }, subject: S, details: S }, ["jobNumber", "who", "subject"], async (a) => {
        if (!(await io.confirm(`Log this call on #${a.jobNumber} in Homebase?`, [`${a.direction === "Inbound" ? "Call from" : "Call to"} ${a.who}`, a.subject, a.details || ""].filter(Boolean)))) return { done: false, reason: "Hunter said no." };
        await logCall(a.jobNumber, a);
        return { done: true };
      }),
      T("calendar_list", "Hunter's calendar between two times (ISO 8601).", { start: S, end: S }, ["start", "end"], (a) => calendarList(a.start, a.end)),
      T("calendar_create", "Put an event on Hunter's calendar and invite people. Times are ISO 8601 local Denver time without an offset (2026-11-12T10:00:00). Hunter is asked to confirm first; invitations go out when he says yes.", { title: S, start: S, end: S, location: S, description: S, attendees: { type: "array", items: S, description: "Email addresses to invite" } }, ["title", "start", "end"], async (a) => {
        const when = `${new Date(a.start).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} to ${new Date(a.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
        if (!(await io.confirm("Add this to your calendar?", [a.title, when, a.location || "", a.attendees?.length ? `Invites: ${a.attendees.join(", ")}` : "No invites"].filter(Boolean)))) return { done: false, reason: "Hunter said no." };
        return { done: true, ...(await calendarCreate(a)) };
      }),
      T("gmail_draft", "Save an email as a DRAFT in Hunter's Gmail (never sends). Give jobNumber to copy the job's Homebase address. Plain text; no signature (Gmail adds his).", { to: { type: "array", items: S }, cc: { type: "array", items: S }, subject: S, body: S, jobNumber: N }, ["to", "subject", "body"], async (a) => {
        if (!(await io.confirm("Save this email as a draft in Gmail?", [`To: ${(a.to || []).join(", ")}`, `Subject: ${a.subject}`, a.body]))) return { done: false, reason: "Hunter said no." };
        await gmailDraft(a);
        return { done: true, note: "Saved in Gmail Drafts. Hunter sends it himself." };
      }),
    ];

    // ------------------------------------------------------------------ Gemini
    const system = () => {
      const s = setup() || {};
      return `You are Keystone on ${s.me?.name || "Hunter"}'s phone. He is a reconstruction estimator at Forefront Building + Restoration in Colorado and is usually talking to you by voice from a job site or his truck.

Right now it's ${new Date().toLocaleString("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (Denver time).

How to answer:
- Short and plain: a sentence or two, the facts first. It may be read aloud, so no tables, no markdown headings, no long lists.
- Phone numbers as (303) 555-0100 and emails in full, so he can tap them.
- Use the tools for anything about jobs, people or his calendar. Never make up a job, a number, an amount or a time.
- When he names a job by customer or street, find it with find_jobs first. If more than one could match, ask which.
- An update he dictates ("tell Homebase the homeowner picked the tile") becomes add_note; a call he describes becomes log_call. Clean up dictation, keep his meaning, add nothing he didn't say.
- For a calendar invite, work out the date from what he says ("Thursday at 10"); an hour long unless he says otherwise; use the job's address as the location; invite only people he names, using their email from the job or his contacts. If you don't have an email for someone, say so and ask.
- Email is drafts only. You can't send email and should say so if asked.
- An email draft to insurance (the job's adjuster or the carrier) always copies the homeowner: put the job's primary contact's email in cc. If the job has no email for them, say so.
- The tools that write (notes, calls, calendar, drafts) show him a Yes/No card. If he says no, don't retry; ask what to change.
- You can't see his texts, walk recordings or job folders from the phone; those are on the laptop.`;
    };

    async function gemini(contents) {
      const s = setup();
      if (!s?.gemini?.key) throw new Error("The AI isn't connected on this phone. Connect Gemini in Keystone on the laptop, then connect the phone again.");
      const models = [s.gemini.model, ...(s.gemini.fallbacks || [])].filter((m, i, a) => m && a.indexOf(m) === i);
      let last = null;
      for (const model of models) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = await json({ method: "POST", url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, headers: { "Content-Type": "application/json", "x-goog-api-key": s.gemini.key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system() }] }, contents, tools: [{ functionDeclarations: tools.map((t) => t.decl) }] }) });
          if (r.ok) {
            const turn = r.json.candidates?.[0]?.content || { role: "model", parts: [] };
            const parts = turn.parts || [];
            return { turn: { role: "model", parts }, text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim(), calls: parts.filter((p) => p.functionCall).map((p) => p.functionCall), model };
          }
          last = new Error(r.status === 429 ? "The AI is at its free limit for the moment. Try again in a minute." : r.status >= 500 ? "The AI is busy right now. Try again in a minute." : `AI: ${r.json?.error?.message || r.status}`);
          if (r.status < 500) break; // a limit or a bad request: the next model, not the same one again
          await new Promise((res) => setTimeout(res, 1500));
        }
      }
      throw last || new Error("The AI didn't answer.");
    }

    /** Keeps the conversation short without cutting a tool call away from its answer. */
    const trim = (c) => {
      if (c.length <= 24) return c;
      let i = c.length - 24;
      while (i < c.length && !(c[i].role === "user" && c[i].parts?.[0]?.text)) i++;
      return c.slice(i);
    };

    /** One spoken or typed request, start to finish. `history` is the conversation so far (kept by the caller). */
    async function ask(text, history, onStep) {
      const contents = [...(history || []), { role: "user", parts: [{ text }] }];
      for (let step = 0; step < 8; step++) {
        const r = await gemini(contents);
        contents.push(r.turn);
        if (!r.calls.length) return { text: r.text || "Done.", history: trim(contents), model: r.model };
        const answers = [];
        for (const c of r.calls) {
          const t = tools.find((x) => x.decl.name === c.name);
          onStep?.(c.name, c.args || {});
          let out;
          try { out = t ? await t.run(c.args || {}) : { error: `No tool named ${c.name}` }; } catch (e) { out = { error: e.message }; }
          answers.push({ functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: { result: out } } });
        }
        contents.push({ role: "user", parts: answers });
      }
      return { text: "That took more steps than I could finish. Try asking for one thing at a time.", history: trim(contents) };
    }

    return { paired, setup, ask, findJobs, getJob, findContact, addNote, logCall, calendarList, calendarCreate, gmailDraft, tools, fmtPhone };
  }

  const api = { create, fmtPhone };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KeystonePhone = api;
})(typeof window !== "undefined" ? window : globalThis);
