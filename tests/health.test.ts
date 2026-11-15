import { afterAll, describe, expect, it } from "vitest";
import { GET as healthGET } from "@/app/api/health/route";
import { closePool } from "@/lib/db";

afterAll(() => closePool());

describe("/api/health", () => {
  it("is public and reports the database as up", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, db: "up" });
  });
});
