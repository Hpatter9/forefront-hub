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
    const addressText = (a) => (!a ? "" : typeof a === "string" ? a : [[a.street, a.unit].filter(Boolean).join(" "), a.city, [a.state, a.zip || a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", "));
    const brief = (p) => ({ jobNumber: Number(p.jobNumber), name: p.name || p.customer || "", address: addressText(p.address), stage: p.stage || "" });
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
        nextAppointment: p.nextAppointment || p.appointment || null,
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
    let stagesCache = null;
    async function stages() {
      if (!stagesCache) stagesCache = (await hb("GET", "/vocabulary")).stages || [];
      return stagesCache;
    }
    /** Moves a job to another stage. Closed Lost needs a reason, so that one stays on the laptop. */
    async function setStage(n, stage) {
      const all = await stages();
      const want = all.find((x) => x.toLowerCase() === String(stage).trim().toLowerCase());
      if (!want) throw new Error(`"${stage}" isn't one of Homebase's stages. They are: ${all.join(", ")}.`);
      if (want === "Closed Lost") throw new Error("Closed Lost needs a loss reason. Do that one in Keystone on the laptop or in Homebase.");
      const id = await projectId(Number(n));
      const r = await hb("GET", `/projects/${id}`);
      const from = (r.project || r).stage;
      if (from === want) return { from, to: want, unchanged: true };
      await hb("PATCH", `/projects/${id}/stage`, { stage: want, fromStage: from });
      mine = null;
      return { from, to: want };
    }

    // ------------------------------------------------------------------ My jobs (the ones Hunter is on)
    // Who's on a job is only on the job's own page, so the open jobs are read once (a few at a time) and kept for the
    // day on the phone.
    let mine = null;
    async function myJobs(force) {
      const me = (setup()?.me?.name || "").toLowerCase();
      if (!force && !mine) { try { mine = JSON.parse(io.get("myJobs") || "null"); } catch { mine = null; } }
      if (!force && mine && Date.now() - mine.at < 12 * 3600e3) return mine.jobs;
      const rows = (await hb("GET", `/projects?${new URLSearchParams({ department: "reconstruction", active: "1", limit: "200" })}`)).projects || [];
      for (const r of rows) ids.set(Number(r.jobNumber), r.id);
      const list = rows.filter((r) => /^\d+$/.test(String(r.jobNumber)));
      const out = [];
      let next = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (next < list.length) {
          const r = list[next++];
          const d = await hb("GET", `/projects/${r.id}`).then((x) => x.project || x).catch(() => null);
          const people = d?.people || { owner: r.owner, projectManager: r.projectManager };
          const onIt = !me || Object.values(people).some((v) => String(v || "").toLowerCase() === me);
          out.push({ ...brief(d || r), address: addressText(d?.address) || addressText(r.address), mine: onIt, stageSince: d?.dates?.stageChanged || "", proposalAmount: d?.money?.proposalAmount ?? null, nextAppointment: d?.nextAppointment || d?.appointment || null, customerPhone: fmtPhone(r.mainContact?.mobile || r.mainContact?.phone || "") });
        }
      }));
      out.sort((a, b) => b.jobNumber - a.jobNumber);
      mine = { at: Date.now(), jobs: out };
      io.set("myJobs", JSON.stringify(mine));
      return out;
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

    // ------------------------------------------------------------------ Google Tasks
    async function tasks() {
      const lists = (await google("GET", "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20")).items || [];
      const out = [];
      for (const l of lists) {
        const r = await google("GET", `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?${new URLSearchParams({ showCompleted: "false", maxResults: "100" })}`);
        for (const t of r.items || []) if (t.title?.trim()) out.push({ id: t.id, list: l.id, title: t.title.trim(), due: t.due ? t.due.slice(0, 10) : "", notes: (t.notes || "").slice(0, 200) });
      }
      // Overdue and due today first, then the dated ones, then the rest.
      return out.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
    }
    async function setTaskDone(list, id, done) {
      await google("PATCH", `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(id)}`, done ? { status: "completed" } : { status: "needsAction", completed: null });
    }

    // ------------------------------------------------------------------ Email waiting on Hunter
    const emailOf = (s) => (String(s || "").match(/[\w.+-]+@[\w.-]+\.\w+/) || [""])[0].toLowerCase();
    /** Recent inbox conversations whose newest message is from someone in his contacts (people on jobs first) and not from him. */
    async function emailWaiting() {
      const s = setup() || {};
      const me = (s.me?.email || "").toLowerCase();
      const byEmail = new Map();
      for (const p of s.contacts || []) for (const e of p.emails || []) byEmail.set(e.toLowerCase(), p);
      const list = (await google("GET", `https://gmail.googleapis.com/gmail/v1/users/me/threads?${new URLSearchParams({ q: "in:inbox newer_than:7d -category:promotions -category:social", maxResults: "20" })}`)).threads || [];
      const out = [];
      let next = 0;
      await Promise.all(Array.from({ length: 5 }, async () => {
        while (next < list.length) {
          const t = list[next++];
          const th = await google("GET", `https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`).catch(() => null);
          const last = th?.messages?.at(-1);
          if (!last) continue;
          const h = (n) => last.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value || "";
          const from = emailOf(h("from"));
          const person = byEmail.get(from);
          if (!from || from === me || !person || !emailOf(h("to")) || !h("to").toLowerCase().includes(me)) continue;
          out.push({ threadId: t.id, at: new Date(Number(last.internalDate) || h("date")).toISOString(), from: person.name, subject: h("subject") || "(no subject)", snippet: (last.snippet || "").slice(0, 160), job: person.jobs?.[0] ? `#${person.jobs[0].jobNumber} ${person.jobs[0].name}` : "" });
        }
      }));
      return out.sort((a, b) => b.at.localeCompare(a.at));
    }

    // ------------------------------------------------------------------ Today
    const dayOf = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });
    const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 864e5)) : null);
    /**
     * What needs Hunter today, built on the phone from Google and Homebase: his calendar, his tasks, email from job
     * people that's waiting on him, and where his own jobs stand (leads without a walk booked, proposals out).
     * Each part that can't be read says why instead of failing the rest. It doesn't know about texts.
     */
    async function today(force) {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 2 * 864e5 - 1);
      const part = async (fn) => { try { return { items: await fn() }; } catch (e) { return { items: [], problem: e.message }; } };
      const [cal, tk, mail, jobs] = await Promise.all([
        // (Each event carries its own day, worked out the same way as "today", so the screen never guesses.)
        part(async () => (await calendarList(start.toISOString(), end.toISOString())).map((e) => ({ ...e, day: /T/.test(e.start || "") ? dayOf(e.start) : String(e.start || "").slice(0, 10) }))),
        part(async () => (await tasks()).filter((t) => !t.due || t.due <= dayOf(end))),
        part(emailWaiting),
        part(async () => (await myJobs(force)).filter((j) => j.mine)),
      ]);
      const leads = jobs.items.filter((j) => /^(lead|qualify)$/i.test(j.stage)).map((j) => ({ ...j, days: daysSince(j.stageSince), walk: j.nextAppointment }));
      const proposals = jobs.items.filter((j) => /^proposal submitted$/i.test(j.stage)).map((j) => ({ ...j, days: daysSince(j.stageSince) })).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
      return { at: new Date().toISOString(), today: dayOf(new Date()), calendar: cal, tasks: tk, email: mail, leads: { items: leads, problem: jobs.problem }, proposals: { items: proposals, problem: jobs.problem } };
    }

    /**
     * The day as one short list, most pressing first: who's waiting on a reply, today's appointments, tasks due,
     * leads with no walk booked, proposals that have sat a few days; then tomorrow and undated tasks. Lines he
     * ticked off today stay off (a task is completed in Google Tasks; the rest are just cleared for the day).
     */
    function doneToday(day) {
      try { const d = JSON.parse(io.get("dayDone") || "null"); return d && d.day === day ? d.ids : []; } catch { return []; }
    }
    function markDone(id, done) {
      const day = dayOf(new Date());
      const ids = doneToday(day).filter((x) => x !== id);
      if (done) ids.push(id);
      io.set("dayDone", JSON.stringify({ day, ids }));
    }
    async function dayList(force) {
      const d = await today(force);
      const time = (iso) => (/T/.test(iso || "") ? new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase() : "All day");
      const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
      const now = [], later = [];
      for (const m of d.email.items) now.push({ id: `e:${m.threadId}`, kind: "email", warn: true, title: `Reply to ${m.from}`, sub: `Waiting on you · ${m.subject}`, threadId: m.threadId, from: m.from, subject: m.subject, snippet: m.snippet });
      for (const e of d.calendar.items) (e.day === d.today ? now : later).push({ id: `c:${e.start}:${e.title}`, kind: "cal", title: `${e.day === d.today ? "" : "Tomorrow "}${time(e.start)} ${e.title}`, sub: e.location || "", location: e.location || "" });
      for (const t of d.tasks.items) (t.due && t.due <= d.today ? now : later).push({ id: `t:${t.id}`, kind: "task", task: t.id, list: t.list, title: t.title, sub: !t.due ? "Task" : t.due < d.today ? "Task · overdue" : t.due === d.today ? "Task · due today" : "Task · due tomorrow" });
      for (const j of d.leads.items) if (!j.walk) now.push({ id: `l:${j.jobNumber}`, kind: "job", jobNumber: j.jobNumber, title: `Book a walk with ${j.name}`, sub: `${j.stage}${j.days != null ? ` · ${plural(j.days, "day")}` : ""}` });
      for (const j of d.proposals.items) (j.days != null && j.days >= 3 ? now : later).push({ id: `p:${j.jobNumber}`, kind: "job", jobNumber: j.jobNumber, title: `Follow up with ${j.name}`, sub: `Proposal out${j.days != null ? ` ${plural(j.days, "day")}` : ""}` });
      const gone = new Set(doneToday(d.today));
      const items = [...now, ...later].filter((x) => !gone.has(x.id));
      const problems = [...new Set([d.email, d.calendar, d.tasks, d.leads].map((x) => x.problem).filter(Boolean))];
      return { at: d.at, today: d.today, items, waiting: items.filter((x) => x.warn).length, problems };
    }

    // ------------------------------------------------------------------ Shop stock (a copy from the laptop)
    function findStock(query) {
      const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
      return (setup()?.stock || []).filter((x) => words.every((w) => `${x.type} ${x.product} ${x.color} ${x.notes} ${x.status}`.toLowerCase().includes(w)));
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
      T("set_stage", "Move a job to another stage in Homebase (for example Scope Walk Scheduled, Estimating, Proposal Submitted). Use Homebase's exact stage name; if unsure, call it anyway and the error lists the stages. Hunter is asked to confirm first.", { jobNumber: N, stage: S }, ["jobNumber", "stage"], async (a) => {
        const all = await stages();
        const want = all.find((x) => x.toLowerCase() === String(a.stage).trim().toLowerCase());
        if (!want) return { done: false, error: `"${a.stage}" isn't a Homebase stage. The stages are: ${all.join(", ")}.` };
        if (!(await io.confirm(`Move #${a.jobNumber} to ${want} in Homebase?`, [`New stage: ${want}`]))) return { done: false, reason: "Hunter said no." };
        return { done: true, ...(await setStage(a.jobNumber, want)) };
      }),
      T("my_day", "What needs Hunter today: his calendar for today and tomorrow, his Google Tasks, email from job people waiting on him, his leads that need a scope walk, and his proposals that are out.", {}, [], () => today(false)),
      T("my_jobs", "Hunter's own open jobs (he's the estimator, owner or PM), with stage and days in stage.", {}, [], async () => (await myJobs(false)).filter((j) => j.mine).map((j) => ({ jobNumber: j.jobNumber, name: j.name, stage: j.stage, days: daysSince(j.stageSince), address: j.address }))),
      T("shop_stock", "The shop's overstock (leftover flooring, tile, carpet tile, cove base, grout, waterproofing, adhesive, paint) Hunter wants to use on jobs. Give words to narrow it (\"LVP\", \"tile beige\") or leave query empty for all. A copy from the laptop as of when the phone was last connected.", { query: S }, [], (a) => {
        const s = setup();
        if (!s?.stock?.length) return { problem: "The shop inventory isn't on this phone. Save the inventory sheet in Keystone's inventory folder on the laptop, then run Connect phone again." };
        return { asOf: s.madeAt, items: findStock(a.query).slice(0, 50) };
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
- To change a job's stage use set_stage. For "what do I have today" use my_day. For his own jobs use my_jobs.
- The shop has overstock he wants used on jobs (shop_stock). When he asks about flooring, tile, cove base, grout, waterproofing, adhesive or paint for a job, check it and say what's on hand and how much.
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

    return { paired, setup, ask, findJobs, getJob, findContact, addNote, logCall, calendarList, calendarCreate, gmailDraft, tools, fmtPhone, stages, setStage, myJobs, tasks, setTaskDone, emailWaiting, today, dayList, markDone, findStock };
  }

  const api = { create, fmtPhone };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KeystonePhone = api;
})(typeof window !== "undefined" ? window : globalThis);
