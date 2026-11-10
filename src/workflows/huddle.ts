import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";

/**
 * The huddle list: things Hunter wants to bring up at the team huddle, written down as they come to mind (from the
 * dashboard, or by asking the AI to add one). Ticked off once discussed. Kept on this computer (.hub/huddle.json).
 */
export interface HuddleItem {
  id: string;
  text: string;
  addedAt: string;
  /** Set once it's been brought up. */
  doneAt?: string;
  jobNumber?: number;
}

const file = (hub: Hub) => path.join(hub.cfg.stateDir, "huddle.json");
export function huddleList(hub: Hub): HuddleItem[] {
  try {
    return existsSync(file(hub)) ? JSON.parse(readFileSync(file(hub), "utf8")) : [];
  } catch {
    return [];
  }
}
function save(hub: Hub, list: HuddleItem[]) {
  mkdirSync(hub.cfg.stateDir, { recursive: true });
  writeFileSync(file(hub), JSON.stringify(list, null, 2));
}

export function huddleAdd(hub: Hub, text: string): HuddleItem {
  const t = text.trim();
  if (!t) throw new Error("Nothing to add.");
  const job = Number(t.match(/#(\d{4})\b/)?.[1]) || undefined;
  const item: HuddleItem = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t.slice(0, 1000), addedAt: new Date().toISOString(), jobNumber: job };
  save(hub, [...huddleList(hub), item]);
  return item;
}

export function huddleUpdate(hub: Hub, id: string, patch: { done?: boolean; text?: string }): HuddleItem {
  const list = huddleList(hub);
  const it = list.find((x) => x.id === id);
  if (!it) throw new Error("That huddle item is gone.");
  if (patch.done !== undefined) it.doneAt = patch.done ? new Date().toISOString() : undefined;
  if (patch.text?.trim()) it.text = patch.text.trim().slice(0, 1000);
  save(hub, list);
  return it;
}

export function huddleRemove(hub: Hub, id: string) {
  save(hub, huddleList(hub).filter((x) => x.id !== id));
}

/** Removes everything already brought up. */
export function huddleClearDone(hub: Hub): number {
  const list = huddleList(hub);
  const keep = list.filter((x) => !x.doneAt);
  save(hub, keep);
  return list.length - keep.length;
}
