/**
 * When the morning brief (Plan my day) runs on its own: 7:00 AM Denver time on weekdays by default.
 * HUB_BRIEF_TIME=08:30 moves it, HUB_BRIEF_TIME=off stops it, HUB_BRIEF_DAYS=0-6 (or "1,3,5") picks the days
 * (0 = Sunday). If Keystone wasn't open at that time, it runs as soon as Keystone opens, until 5 PM (HUB_BRIEF_UNTIL). One a day:
 * a Plan my day you ran yourself that morning counts.
 */
export const BRIEF = { at: (process.env.HUB_BRIEF_TIME ?? "07:00").trim(), days: (process.env.HUB_BRIEF_DAYS ?? "1-5").trim(), until: (process.env.HUB_BRIEF_UNTIL ?? "17:00").trim() };
export function briefDue(now: Date, last: { startedAt?: string } | null, o = BRIEF): boolean {
  if (!/^\d{1,2}:\d{2}$/.test(o.at)) return false; // "off"
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(now).map((x) => [x.type, x.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const [lo, hi] = o.days.includes("-") ? o.days.split("-").map(Number) : [NaN, NaN];
  const okDay = o.days.includes("-") ? day >= lo && day <= hi : o.days.split(",").map(Number).includes(day);
  const hm = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
  const at = o.at.padStart(5, "0");
  if (!okDay || hm < at || hm >= o.until) return false;
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const lastDay = last?.startedAt ? new Date(last.startedAt).toLocaleDateString("en-CA", { timeZone: "America/Denver" }) : "";
  return lastDay !== today; // one brief a day: a Plan my day you ran yourself this morning counts
}
