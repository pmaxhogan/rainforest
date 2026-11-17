import { z } from "zod";
import { CAP_CEILINGS, type PacingOverrides } from "@rainforest/browser";
import { atomicWriteJson, readTextIfExists } from "./fsutil.ts";
import type { AppPaths } from "./paths.ts";

/**
 * config.json. There are deliberately NO owner-specific defaults here: hub_url, device
 * identity, the Chrome profile and the update repository all come from `rainforestd setup`
 * (or flags). Only neutral tuning knobs have defaults.
 */

const httpsUrl = z
  .url()
  .max(512)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL");

export const DEFAULT_BROKER_PORT = 47117;
export const DEFAULT_IDLE_DETACH_S = 120;
export const DEFAULT_UPDATE_CHECK_INTERVAL_S = 6 * 3600;

const chromeSchema = z.object({
  /** Chrome profile directory name, e.g. "Default" or "Profile 2". */
  profile_directory: z.string().min(1).max(128),
  /** Id of the installed automation extension. */
  extension_id: z.string().regex(/^[a-p]{32}$/),
  user_data_dir: z.string().min(1).max(1024).optional(),
  executable_path: z.string().min(1).max(1024).optional(),
});

const brokerSchema = z.object({
  /** external: an already running broker; embedded: the daemon starts and supervises one. */
  mode: z.enum(["external", "embedded"]).default("external"),
  port: z.number().int().min(1).max(65535).default(DEFAULT_BROKER_PORT),
  start_command: z.array(z.string().min(1).max(1024)).min(1).max(32).optional(),
});

const updateSchema = z.object({
  /** GitHub "owner/name" that publishes releases. Supplied by setup, never hard-coded. */
  repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "must look like owner/name"),
  channel: z.literal("stable").default("stable"),
  enabled: z.boolean().default(true),
  check_interval_s: z
    .number()
    .int()
    .min(300)
    .max(7 * 86_400)
    .default(DEFAULT_UPDATE_CHECK_INTERVAL_S),
});

/**
 * Optional pacing caps for THIS computer only; the shipped defaults do not move. Example:
 * { "burst": { "loads": 12 }, "all": { "per_hour": 30 }, "product": { "per_hour": 20 } }.
 * `burst.loads` is the number of page loads allowed in any 10 minutes, `all` the caps
 * across page types, and a page type name its own caps. Strict on purpose: an unknown key
 * or a value above the ceiling is a config error, never a silently looser limit. The gap
 * between loads, the burst window and the cool-downs are not adjustable.
 */
const capsOverride = z.strictObject({
  per_hour: z.number().int().min(1).max(CAP_CEILINGS.perHour).optional(),
  per_day: z.number().int().min(1).max(CAP_CEILINGS.perDay).optional(),
});
const pacingSchema = z.strictObject({
  burst: z.strictObject({ loads: z.number().int().min(1).max(CAP_CEILINGS.burstLoads) }).optional(),
  all: capsOverride.optional(),
  search: capsOverride.optional(),
  product: capsOverride.optional(),
  offers: capsOverride.optional(),
  reviews: capsOverride.optional(),
  account: capsOverride.optional(),
  cart: capsOverride.optional(),
  list: capsOverride.optional(),
  price_history: capsOverride.optional(),
});

export const configSchema = z.looseObject({
  hub_url: httpsUrl,
  device_id: z.string().min(8).max(64),
  device_name: z.string().min(1).max(64),
  // Same limits as the wire protocol: a longer alias would fail every hub handshake.
  aliases: z.array(z.string().min(1).max(40)).max(8).default([]),
  chrome: chromeSchema,
  broker: brokerSchema.default(() => ({ mode: "external" as const, port: DEFAULT_BROKER_PORT })),
  update: updateSchema,
  pacing: pacingSchema.optional(),
  idle_detach_s: z.number().int().min(0).max(86_400).default(DEFAULT_IDLE_DETACH_S),
});

export type DaemonConfig = z.infer<typeof configSchema>;
export type DaemonConfigInput = z.input<typeof configSchema>;

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Validate an unknown value. Issue text carries paths and rules, never the offending values. */
export function parseConfig(value: unknown): DaemonConfig {
  const result = configSchema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new ConfigError("invalid config", issues);
}

export function loadConfig(paths: AppPaths): DaemonConfig {
  const text = readTextIfExists(paths.configFile);
  if (text === null) {
    throw new ConfigError("config.json not found; run `rainforestd setup`");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError("config.json is not valid JSON");
  }
  return parseConfig(json);
}

/** Validate, then write atomically (temp file + rename). Returns the normalized config. */
export function saveConfig(paths: AppPaths, config: DaemonConfigInput): DaemonConfig {
  const parsed = parseConfig(config);
  atomicWriteJson(paths.configFile, parsed);
  return parsed;
}

/**
 * The config's pacing caps in the shape the pacer takes. Values are clamped to the
 * ceilings again here, so a config object that did not come through `parseConfig` still
 * cannot raise a cap past them.
 */
export function pacingOverrides(pacing: DaemonConfig["pacing"]): PacingOverrides {
  if (!pacing) return {};
  const caps = (
    value: { per_hour?: number | undefined; per_day?: number | undefined } | undefined,
  ): { perHour?: number; perDay?: number } => ({
    ...(value?.per_hour !== undefined
      ? { perHour: Math.min(value.per_hour, CAP_CEILINGS.perHour) }
      : {}),
    ...(value?.per_day !== undefined
      ? { perDay: Math.min(value.per_day, CAP_CEILINGS.perDay) }
      : {}),
  });
  const { burst, all, ...types } = pacing;
  const out: PacingOverrides = {};
  if (burst) out.burst = { loads: Math.min(burst.loads, CAP_CEILINGS.burstLoads) };
  if (all) out.global = caps(all);
  const perType = Object.entries(types).filter(([, value]) => value !== undefined);
  if (perType.length > 0) {
    out.caps = Object.fromEntries(perType.map(([type, value]) => [type, caps(value)]));
  }
  return out;
}

/** Config summary safe to print: no secrets live in config.json, but keep the shape explicit. */
export function summarizeConfig(config: DaemonConfig): Record<string, unknown> {
  return {
    hub_url: config.hub_url,
    device_id: config.device_id,
    device_name: config.device_name,
    aliases: config.aliases,
    chrome: {
      profile_directory: config.chrome.profile_directory,
      extension_id: config.chrome.extension_id,
      custom_user_data_dir: config.chrome.user_data_dir !== undefined,
      custom_executable: config.chrome.executable_path !== undefined,
    },
    broker: { mode: config.broker.mode, port: config.broker.port },
    update: {
      repo: config.update.repo,
      channel: config.update.channel,
      enabled: config.update.enabled,
      check_interval_s: config.update.check_interval_s,
    },
    idle_detach_s: config.idle_detach_s,
    ...(config.pacing ? { pacing: config.pacing } : {}),
  };
}
