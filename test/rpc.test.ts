import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adjustReservation, cancelReserved, getJob, utcDay } from "../src/db";
import { bot, mp4, png, resetDb, seedClient, seedInputs, spend, web } from "./helpers";

// max_parallel 0 keeps every Workflow waiting for a slot, so these tests see only the RPC side.
let workflows: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeEach(async () => {
  await resetDb();
  await seedClient("bot", { maxParallel: 0, dailyCapCents: 250 });
  await seedClient("web", { maxParallel: 0 });
  workflows = await introspectWorkflow(env.GENERATE_JOB);
});
afterEach(async () => {
  await workflows.dispose();
  vi.restoreAllMocks();
});

const genjutsu = (video: { trendId: string }, imageId: string, clientJobId = "c1") => ({
  clientJobId,
  model: "genjutsu-light/motion-transfer" as const,
  resolution: "480p" as const,
  imageInputIds: [imageId],
  video,
  maxUsd: 5,
});

describe("createJob", () => {
  it("reserves the list price and returns the same job for the same clientJobId", async () => {
    const { trendId, imageId } = await seedInputs("bot");
    const first = await bot().createJob(genjutsu({ trendId }, imageId));
    // 480p: $0.05/s × (10 s output + 10 s input)
    expect(first.estUsd).toBe(1);
    expect(await spend("bot")).toEqual({ reserved: 100, spent: 0 });
    expect(await spend("_global")).toEqual({ reserved: 100, spent: 0 });

    const again = await bot().createJob(genjutsu({ trendId }, imageId));
    expect(again).toEqual(first);
    expect(await spend("bot")).toEqual({ reserved: 100, spent: 0 });
  });

  it("stops at the client's daily cap without touching the reservation", async () => {
    const { trendId, imageId } = await seedInputs("bot");
    await bot().createJob(genjutsu({ trendId }, imageId, "a"));
    await bot().createJob(genjutsu({ trendId }, imageId, "b"));
    await expect(bot().createJob(genjutsu({ trendId }, imageId, "c"))).rejects.toThrow("budget_exceeded");
    expect(await spend("bot")).toEqual({ reserved: 200, spent: 0 });
  });

  it("stops at the global daily cap", async () => {
    await env.DB.prepare("INSERT INTO spend (client_id, day, cap_cents, spent_cents) VALUES ('_global', ?, 5000, 4950)").bind(utcDay()).run();
    const { trendId, imageId } = await seedInputs("web");
    await expect(web().createJob(genjutsu({ trendId }, imageId))).rejects.toThrow("budget_exceeded");
    // The whole batch rolled back, including the client's new spend row and the job.
    expect(await spend("web")).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first("n")).toBe(0);
  });

  it("refuses models, prices and inputs the client may not use", async () => {
    const { trendId, imageId } = await seedInputs("bot");
    await expect(bot().createJob({ ...genjutsu({ trendId }, imageId), resolution: "1080p" })).rejects.toThrow("model_not_allowed");
    await expect(bot().createJob({ ...genjutsu({ trendId }, imageId), maxUsd: 0.5 })).rejects.toThrow("over_max_usd");
    await expect(web().createJob(genjutsu({ trendId }, imageId))).rejects.toThrow("not_found");
    await expect(bot().createJob({ ...genjutsu({ trendId }, imageId), imageInputIds: [] })).rejects.toThrow("invalid_input");
  });
});

describe("client isolation", () => {
  it("hides one client's jobs from another", async () => {
    const { trendId, imageId } = await seedInputs("bot");
    const { jobId } = await bot().createJob(genjutsu({ trendId }, imageId));
    expect(await bot().getJob(jobId)).toEqual({ status: "reserved" });
    await expect(web().getJob(jobId)).rejects.toThrow("not_found");
    await expect(web().cancelJob(jobId)).rejects.toThrow("not_found");
    await expect(web().openResult(jobId)).rejects.toThrow("not_found");
  });
});

describe("cancelJob", () => {
  it("releases a job still waiting for a slot", async () => {
    const { trendId, imageId } = await seedInputs("bot");
    const { jobId } = await bot().createJob(genjutsu({ trendId }, imageId));
    await bot().cancelJob(jobId);
    expect(await bot().getJob(jobId)).toEqual({ status: "canceled", usd: 0 });
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 0 });
  });

  it("releases nothing when the job was submitted before the cancel landed", async () => {
    const { trendId, imageId } = await seedInputs("bot");
    const { jobId } = await bot().createJob(genjutsu({ trendId }, imageId));
    const job = (await getJob(env.DB, jobId))!;
    await env.DB.prepare("UPDATE jobs SET status = 'submitted', hf_request = 'req-race' WHERE id = ?").bind(jobId).run();

    expect(await cancelReserved(env.DB, job)).toBe(false);
    expect((await getJob(env.DB, jobId))!.status).toBe("submitted");
    expect(await spend("bot")).toEqual({ reserved: 100, spent: 0 });
  });
});

describe("adjustReservation", () => {
  it("reports a lost job instead of a silent no-op", async () => {
    const { trendId, imageId } = await seedInputs("bot");
    const { jobId } = await bot().createJob(genjutsu({ trendId }, imageId));
    const job = (await getJob(env.DB, jobId))!;
    await env.DB.prepare("UPDATE jobs SET status = 'canceled' WHERE id = ?").bind(jobId).run();

    expect(await adjustReservation(env.DB, job, 120)).toBe("lost");
    expect(await spend("bot")).toEqual({ reserved: 100, spent: 0 });
  });
});

describe("putInput", () => {
  it("streams a large video to R2 in parts and reads moov from its end", async () => {
    // 11 MiB of mdat before moov: three multipart parts, and moov only reachable by range reads.
    const file = mp4({ seconds: 9, width: 1280, height: 720, rotate90: true, mdatBytes: 11 * 1024 * 1024 });
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < file.length; at += 1_000_000) controller.enqueue(file.subarray(at, at + 1_000_000));
        controller.close();
      },
    });
    const { inputId } = await bot().putInput(chunks, "video/mp4");
    const row = await env.DB.prepare("SELECT client_id, kind, seconds, width, height, r2_key FROM inputs WHERE id = ?").bind(inputId).first();
    expect(row).toEqual({ client_id: "bot", kind: "video", seconds: 9, width: 720, height: 1280, r2_key: `in/${inputId}` });
    const stored = await env.MEDIA.get(`in/${inputId}`);
    const sha = async (data: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", data))));
    expect(await sha(await stored!.arrayBuffer())).toBe(await sha(file));
  });

  it("stores an image with its size", async () => {
    const { inputId } = await bot().putInput(new Blob([png(512, 768)]).stream(), "image/png");
    expect(await env.DB.prepare("SELECT kind, width, height FROM inputs WHERE id = ?").bind(inputId).first()).toEqual({
      kind: "image",
      width: 512,
      height: 768,
    });
  });

  it("refuses files that aren't what they claim, and removes a refused video", async () => {
    await expect(bot().putInput(new Blob(["<html>"]).stream(), "image/png")).rejects.toThrow("invalid_input");
    await expect(bot().putInput(new Blob([png(100, 100)]).stream(), "image/png")).rejects.toThrow("at least 300 px");
    await expect(bot().putInput(new Blob(["not a video at all"]).stream(), "video/mp4")).rejects.toThrow("invalid_input");
    expect((await env.MEDIA.list({ prefix: "in/" })).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM inputs").first("n")).toBe(0);
  });
});
