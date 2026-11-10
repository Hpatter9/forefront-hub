import { describe, expect, it } from "vitest";
import type { Contact, JobAccount } from "../src/connectors/homebase/types.js";
import { customerFor } from "../src/workflows/pull.js";
import { TemplateWriter } from "../src/workflows/writer.js";
import { testHub } from "./helpers.js";

const pm: JobAccount = { id: "acc-1", name: "Westwind Management Group", subtype: "Residential property manager", propertyManager: true, billingEmail: "billing@westwind.example", phone: "303-555-0100" };
const tenant: Contact = { role: "customer", name: "Pat Tenant", email: "pat@gmail.example", phone: "720-555-0101" };
const manager: Contact = { role: "other", name: "Morgan Manager", email: "morgan@westwind.example", phone: "303-555-0102", accountId: "acc-1", roles: ["Billing"] };

describe("property management jobs", () => {
  it("make the management company the customer, with its person, and keep the tenant as the on-site contact", () => {
    const r = customerFor({ contacts: [tenant, manager], account: pm });
    expect(r.managed).toBe(true);
    expect(r.customer).toMatchObject({ name: "Westwind Management Group", company: "Westwind Management Group", attention: "Morgan Manager", email: "morgan@westwind.example" });
    expect(r.occupant?.name).toBe("Pat Tenant");
  });

  it("fall back to the company's billing email when nobody at the company is listed", () => {
    const r = customerFor({ contacts: [tenant], account: pm });
    expect(r.customer).toMatchObject({ name: "Westwind Management Group", attention: "", email: "billing@westwind.example" });
    expect(r.customer?.email).not.toBe(tenant.email);
  });

  it("when the primary contact works at the company, it's both the person and not an occupant", () => {
    const r = customerFor({ contacts: [{ ...manager, role: "customer", roles: ["Primary"] }], account: pm });
    expect(r.customer?.attention).toBe("Morgan Manager");
    expect(r.occupant).toBeUndefined();
  });

  it("leave ordinary jobs on the primary contact", () => {
    expect(customerFor({ contacts: [tenant], account: { name: "Pat Tenant", propertyManager: false } }).customer?.name).toBe("Pat Tenant");
    expect(customerFor({ contacts: [tenant] }).managed).toBe(false);
  });

  it("greet the person at the company in the plain send-off, never the company name", async () => {
    const { hub } = testHub();
    const job = hub.jobs.upsert(4300, { name: "Westwind", address: "9 Oak St, Denver, CO", customer: { name: "Westwind Management Group", company: "Westwind Management Group", attention: "", email: "billing@westwind.example", phone: "" } });
    expect((await new TemplateWriter().writeEmail({ job, kind: "homeowner", total: 100, attachments: [] })).body).toMatch(/^Hi there,/);
    const j2 = hub.jobs.upsert(4300, { customer: { ...job.customer, attention: "Morgan Manager" } });
    expect((await new TemplateWriter().writeEmail({ job: j2, kind: "homeowner", total: 100, attachments: [] })).body).toMatch(/^Hi Morgan,/);
  });
});
