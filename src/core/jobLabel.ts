/**
 * What a job is called in menus and pop-ups. Most jobs go by the customer's name ("Gorrell"). A property-management
 * job, or a customer with more than one job, goes by name and street instead, so they can be told apart:
 * "LCP Development: 5925 E Evans", "McCandless: 19 Foxtail". Two at the same street get the unit ("#302"); if even
 * that doesn't tell them apart, the job number.
 */
export interface Labelable {
  jobNumber: number;
  name: string;
  address?: string;
  /** Set on property-management jobs: the management company. */
  company?: string;
}

const SUFFIX = new Set("st street ave av avenue dr drive rd road blvd boulevard ln lane ct court cir circle way pl place pkwy parkway ter terrace trl trail hwy highway sq square loop pt point xing crossing cv cove".split(" "));
const DIRECTION = new Set("n s e w ne nw se sw north south east west".split(" "));
const UNIT_WORD = /^(?:#|unit|apt\.?|apartment|ste\.?|suite|bldg\.?|building|lot|no\.?)\s*/i;

/** The street without its type ("5925 E Evans Ave" → "5925 E Evans") and the unit, if the address has one. */
export function streetAndUnit(address = ""): { street: string; unit: string } {
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  let street = parts[0] ?? "";
  let unit = "";
  const inline = street.match(/\s+(?:#\s*|(?:unit|apt\.?|apartment|ste\.?|suite|bldg\.?|building)\s+#?)([\w-]+)$/i);
  if (inline) { unit = inline[1]; street = street.slice(0, inline.index).trim(); }
  // A part after the street that is a unit ("Unit 302", "#302", "302B"), not the city.
  const next = parts[1] ?? "";
  if (!unit && (UNIT_WORD.test(next) ? /\d/.test(next) : /^[\w-]{1,6}$/.test(next) && /\d/.test(next))) unit = next.replace(UNIT_WORD, "").trim();
  const words = street.split(/\s+/).filter(Boolean);
  const low = (i: number) => (words[i] ?? "").toLowerCase().replace(/\.$/, "");
  // "Main St NW" → "Main"; "Evans Ave" → "Evans"; never cut a street down to just its number.
  if (words.length > 3 && DIRECTION.has(low(words.length - 1)) && SUFFIX.has(low(words.length - 2))) words.splice(-2);
  else if (words.length > 2 && SUFFIX.has(low(words.length - 1))) words.pop();
  return { street: words.join(" "), unit };
}

const groupKey = (s: string) => s.toLowerCase().replace(/[.,]/g, " ").replace(/\b(llc|inc|co|corp|ltd|company)\b/g, "").replace(/\s+/g, " ").trim();

/** Every job's label, by job number. Pass all the jobs that show together so a customer's other jobs are seen. */
export function jobLabels(jobs: Labelable[]): Map<number, string> {
  const out = new Map<number, string>();
  const groups = new Map<string, Labelable[]>();
  for (const j of jobs) {
    const who = (j.company || j.name || "").trim();
    const key = groupKey(who) || `#${j.jobNumber}`;
    groups.set(key, [...(groups.get(key) ?? []), j]);
  }
  for (const list of groups.values()) {
    const pm = list.some((j) => j.company);
    if (list.length < 2 && !pm) { out.set(list[0].jobNumber, list[0].name || `#${list[0].jobNumber}`); continue; }
    // The whole group goes by one spelling of the name (the first job's), so they sort and read together.
    const who = (list[0].company || list[0].name).trim();
    const rows = list.map((j) => ({ j, ...streetAndUnit(j.address) }));
    const base = (r: (typeof rows)[number]) => (r.street ? `${who}: ${r.street}` : who);
    const count = (f: (r: (typeof rows)[number]) => string) => (r: (typeof rows)[number]) => rows.filter((x) => f(x).toLowerCase() === f(r).toLowerCase()).length;
    const withUnit = (r: (typeof rows)[number]) => (count(base)(r) > 1 && r.unit ? `${base(r)} #${r.unit}` : base(r));
    for (const r of rows) out.set(r.j.jobNumber, count(withUnit)(r) > 1 ? `${withUnit(r)} (#${r.j.jobNumber})` : withUnit(r));
  }
  return out;
}
