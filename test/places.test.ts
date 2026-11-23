import { describe, expect, it } from "vitest";
import { placeLabel } from "../src/connectors/travel/index.js";
import { forgetPastLocations, suggestPlaces } from "../src/workflows/places.js";
import { pullJob } from "../src/workflows/pull.js";
import { testHub } from "./helpers.js";

describe("Location suggestions for calendar events", () => {
  it("offers a job's address by its street or its name, then places used before, then the map", async () => {
    const { hub } = testHub();
    forgetPastLocations();
    await pullJob(hub, 9001);
    const job = hub.jobs.get(9001);
    expect((await suggestPlaces(hub, job.name.slice(0, 4)))[0]).toMatchObject({ label: job.address, kind: "job", sub: `#9001 ${job.name}` });
    expect((await suggestPlaces(hub, job.address.split(",")[0].slice(0, 6)))[0]).toMatchObject({ label: job.address, kind: "job" });
    await hub.calendar.create({ title: "Lunch", start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 7200_000).toISOString(), location: "Rosie's Diner, 14061 E Iliff Ave, Aurora" } as any);
    forgetPastLocations();
    expect((await suggestPlaces(hub, "rosie")).map((p) => p.kind)).toEqual(["past", "map"]);
    expect((await suggestPlaces(hub, "742 Evergreen")).at(-1)).toMatchObject({ kind: "map", label: "742 Evergreen Example St, Denver, CO 80202" });
    expect(await suggestPlaces(hub, "x")).toEqual([]);
  });

  it("writes a map result as one address line", () => {
    expect(placeLabel({ housenumber: "2830", street: "South Vine Street", city: "Denver", state: "Colorado", postcode: "80210" })).toBe("2830 South Vine Street, Denver, CO 80210");
    expect(placeLabel({ name: "Home Depot", street: "East Arapahoe Road", city: "Centennial", state: "Colorado" })).toBe("Home Depot, East Arapahoe Road, Centennial, CO");
    expect(placeLabel({ name: "Parker", state: "Colorado", county: "Douglas County" })).toBe("Parker, Douglas County, CO");
  });
});
