import { describe, expect, it } from "vitest";
import type { CalEvent } from "../src/connectors/calendar/index.js";
import { routable, SPARE_MINUTES, travelFor } from "../src/workflows/travel.js";
import { MockTravel } from "../src/connectors/travel/index.js";
import { testHub } from "./helpers.js";

const ev = (id: string, start: string, end: string, location?: string): CalEvent => ({ id, calendarId: "primary", title: id, start, end, allDay: false, location });

describe("drive times for calendar events", () => {
  it("routes from the office first, then from the previous appointment, with a leave-by time", async () => {
    const { hub } = testHub();
    hub.cfg.travel.start = "169 Inverness Dr W, Englewood, CO";
    const legs = await travelFor(hub, [
      ev("walk", "2026-11-09T09:00:00-07:00", "2026-11-09T10:00:00-07:00", "1071 Acapulco Ct, Colorado Springs, CO"),
      ev("zoom", "2026-11-09T10:30:00-07:00", "2026-11-09T11:00:00-07:00", "https://zoom.us/j/123"),
      ev("next", "2026-11-09T10:05:00-07:00", "2026-11-09T11:00:00-07:00", "123 Main St, Denver, CO"),
    ]);
    const calls = (hub.travel as MockTravel).calls;
    expect(calls[0].from).toContain("Inverness");
    expect(calls[1].from).toContain("Acapulco");
    expect(legs.zoom).toBeUndefined();
    expect(legs.walk.fromLabel).toBe("the office");
    const leave = new Date("2026-11-09T09:00:00-07:00").getTime() - (legs.walk.minutes + SPARE_MINUTES) * 60_000;
    expect(legs.walk.leaveBy).toBe(new Date(leave).toISOString());
    expect(legs.next.fromLabel).toBe("walk");
    expect(legs.next.late).toBeGreaterThan(0); // 5 minutes between them isn't enough
    expect(legs.next.mapsUrl).toContain("google.com/maps/dir");
  });

  it("only routes real places", () => {
    expect(routable("123 Main St, Denver, CO")).toBe(true);
    expect(routable("https://meet.google.com/abc")).toBe(false);
    expect(routable("Phone")).toBe(false);
    expect(routable("")).toBe(false);
  });
});

describe("travel connectors", () => {
  it("asks Google's Routes API for a traffic-aware drive and reads its answer", async () => {
    const { GoogleTravel } = await import("../src/connectors/travel/index.js");
    const { mkdtempSync } = await import("node:fs");
    const os = await import("node:os");
    const sent: any[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ routes: [{ duration: "1530s", distanceMeters: 24140 }] }), { status: 200 });
    }) as any;
    try {
      const g = new GoogleTravel(mkdtempSync(`${os.tmpdir()}/trv-`), "KEY");
      const leave = new Date(Date.now() + 3600_000);
      const d = await g.drive("169 Inverness Dr W, Englewood, CO", "123 Main St, Denver, CO", leave);
      expect(d).toEqual({ minutes: 26, miles: 15, traffic: true });
      expect(sent[0].url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
      expect(sent[0].init.headers["X-Goog-Api-Key"]).toBe("KEY");
      const body = JSON.parse(sent[0].init.body);
      expect(body).toMatchObject({ travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", departureTime: leave.toISOString() });
      await g.drive("169 Inverness Dr W, Englewood, CO", "123 Main St, Denver, CO", leave);
      expect(sent).toHaveLength(1); // kept for the same half hour
    } finally {
      globalThis.fetch = real;
    }
  });

  it("uses OpenStreetMap without a key, padding for traffic", async () => {
    const { OsmTravel, TRAFFIC_PAD } = await import("../src/connectors/travel/index.js");
    const { mkdtempSync } = await import("node:fs");
    const os = await import("node:os");
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      new Response(String(url).includes("nominatim") ? JSON.stringify([{ lat: "39.7", lon: "-104.9" }]) : JSON.stringify({ code: "Ok", routes: [{ duration: 1200, distance: 16093 }] }), { status: 200 })) as any;
    try {
      const d = await new OsmTravel(mkdtempSync(`${os.tmpdir()}/trv-`)).drive("A St 1, Denver", "B St 2, Denver");
      expect(d).toEqual({ minutes: Math.round((1200 * TRAFFIC_PAD) / 60), miles: 10, traffic: false });
    } finally {
      globalThis.fetch = real;
    }
  }, 10_000);
});
