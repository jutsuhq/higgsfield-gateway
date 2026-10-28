// Per-model rules: input limits, list price and the Higgsfield request body.
// List prices are upper bounds for the reservation; /estimate prices the exact body before submit.
// Rates as of 2026-10-26, see docs/higgsfield-api.md (Pricing).

import { GatewayError, type AspectRatio, type Model, type Resolution } from "./env";

export interface JobSpec {
  imageInputIds: string[];
  video: { trendId: string } | { inputId: string };
  prompt?: string;
  seedance?: { aspectRatio?: AspectRatio; duration?: number; generateAudio?: boolean };
}

export interface SourceVideo {
  r2Key: string;
  seconds: number;
  width: number;
  height: number;
}

export interface MediaUrls {
  video: string;
  images: string[];
}

interface ModelRules {
  endpoint: string;
  /** Throws `GatewayError("invalid_input")` when the job breaks the model's limits. */
  validate(spec: JobSpec, video: SourceVideo, imageCount: number): void;
  listPriceCents(resolution: Resolution, video: SourceVideo, spec: JobSpec): number;
  body(urls: MediaUrls, resolution: Resolution, video: SourceVideo, spec: JobSpec): object;
}

const ASPECT_RATIOS: AspectRatio[] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

export const MODELS: Record<Model, ModelRules> = {
  "genjutsu-light/motion-transfer": {
    endpoint: "higgsfield/genjutsu-light/motion-transfer/v1.0",
    validate(spec, video, imageCount) {
      check(imageCount >= 1 && imageCount <= 8, "1–8 images");
      check(video.seconds >= 4 && video.seconds <= 15, "a 4–15 s video");
      check((spec.prompt ?? "").length <= 10_000, "a prompt of at most 10,000 characters");
      check(!spec.seedance, "no Seedance options");
    },
    // Billed seconds: the output (as long as the source, up to 15 s) plus the input video.
    listPriceCents(resolution, video) {
      const rate = { "480p": 5, "720p": 10, "1080p": 20 }[resolution];
      return rate * 2 * Math.ceil(Math.min(video.seconds, 15));
    },
    // The API rejects null: prompt and image_urls are always sent.
    body(urls, resolution, _video, spec) {
      return { video_url: urls.video, image_urls: urls.images, prompt: spec.prompt ?? "", resolution };
    },
  },

  "seedance-2.5/reference-to-video": {
    endpoint: "bytedance/seedance-2.5/reference-to-video",
    validate(spec, video, imageCount) {
      const duration = spec.seedance?.duration;
      check(imageCount <= 30, "at most 30 images");
      check(video.seconds >= 2 && video.seconds <= 30, "a 2–30 s video");
      check(duration === undefined || (Number.isInteger(duration) && duration >= 4 && duration <= 30), "a duration of 4–30 s");
      check(!spec.seedance?.aspectRatio || ASPECT_RATIOS.includes(spec.seedance.aspectRatio), "a supported aspect ratio");
    },
    // $/s of output at 16:9 (tokens of the output frame); with a reference video, input and output
    // seconds are both billed at 0.6 of the rate. Other ratios can cost more; /estimate catches that.
    listPriceCents(resolution, video, spec) {
      const microUsdPerSecond = { "480p": 205_600, "720p": 462_200, "1080p": 1_137_200 }[resolution];
      const seconds = Math.ceil(video.seconds) + seedanceDuration(video, spec);
      return Math.ceil((microUsdPerSecond * 0.6 * seconds) / 10_000);
    },
    // The schema forbids unknown keys, null and empty arrays or prompt, so those are left out.
    body(urls, resolution, video, spec) {
      return {
        video_urls: [urls.video],
        ...(urls.images.length ? { image_urls: urls.images } : {}),
        ...(spec.prompt ? { prompt: spec.prompt } : {}),
        duration: seedanceDuration(video, spec),
        resolution,
        // The API defaults to 16:9, which would turn a vertical source horizontal.
        aspect_ratio: spec.seedance?.aspectRatio ?? nearestAspectRatio(video.width, video.height),
        generate_audio: spec.seedance?.generateAudio ?? false,
      };
    },
  },
};

export function isModel(value: string): value is Model {
  return Object.hasOwn(MODELS, value);
}

function seedanceDuration(video: SourceVideo, spec: JobSpec): number {
  return spec.seedance?.duration ?? Math.min(30, Math.max(4, Math.ceil(video.seconds)));
}

export function nearestAspectRatio(width: number, height: number): AspectRatio {
  const target = Math.log(width / height);
  const distance = (r: AspectRatio) => {
    const [w, h] = r.split(":").map(Number) as [number, number];
    return Math.abs(Math.log(w / h) - target);
  };
  return ASPECT_RATIOS.reduce((best, r) => (distance(r) < distance(best) ? r : best));
}

function check(ok: boolean, expected: string): asserts ok {
  if (!ok) throw new GatewayError("invalid_input", `this model needs ${expected}`);
}
