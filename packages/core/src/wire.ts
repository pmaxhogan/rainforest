import { z } from "zod";
import { ERROR_CODES, HUMAN_KINDS } from "./errors.ts";

/**
 * Hub <-> daemon wire protocol. JSON text frames over one outbound WebSocket per daemon.
 * Bump PROTOCOL_VERSION on any incompatible change; MIN_PEER_PROTOCOL is the oldest
 * version this build still talks to.
 */
export const PROTOCOL_VERSION = 1;
export const MIN_PEER_PROTOCOL = 1;

/** Longest a tool call may run inside the daemon, in milliseconds. */
export const CALL_DEADLINE_MS = 225_000;

export const errorPayloadSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string().max(2000),
  kind: z.enum(HUMAN_KINDS).optional(),
  retry_after_s: z.number().nonnegative().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const presenceSchema = z.object({
  idle_s: z.number().nonnegative(),
  locked: z.boolean(),
  chrome_running: z.boolean(),
  profile_connected: z.boolean(),
  amazon_signed_in: z.boolean().nullable(),
  cooling_down_until: z.number().nullable(),
  version: z.string().max(64),
  /** Extra names the owner gave this computer in its local config. */
  aliases: z.array(z.string().min(1).max(40)).max(8).optional(),
  /** Remaining pacing budget per page type ("all" is the cap across types). */
  budget: z
    .record(z.string().max(32), z.object({ hour_left: z.number(), day_left: z.number() }))
    .optional(),
});
export type Presence = z.infer<typeof presenceSchema>;

/** Image returned next to the JSON result (media and price charts only). */
export const imageBlockSchema = z.object({
  mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  data_base64: z.string().max(1_500_000),
});
export type ImageBlock = z.infer<typeof imageBlockSchema>;

// ---- hub -> daemon
export const hubChallenge = z.object({
  type: z.literal("challenge"),
  nonce: z.string().min(32).max(128),
});
export const hubWelcome = z.object({
  type: z.literal("welcome"),
  protocol: z.number().int(),
  min_daemon_version: z.string().max(64).optional(),
});
export const hubCall = z.object({
  type: z.literal("call"),
  id: z.string().min(8).max(64),
  tool: z.string().max(64),
  args: z.record(z.string(), z.unknown()),
  deadline_ms: z.number().int().positive(),
});
export const hubUpdateHint = z.object({ type: z.literal("update_hint") });
export const hubMessage = z.discriminatedUnion("type", [
  hubChallenge,
  hubWelcome,
  hubCall,
  hubUpdateHint,
]);
export type HubMessage = z.infer<typeof hubMessage>;
export type HubCall = z.infer<typeof hubCall>;

// ---- daemon -> hub
export const daemonAuth = z.object({
  type: z.literal("auth"),
  device_id: z.string().min(8).max(64),
  protocol: z.number().int(),
  /** base64url Ed25519 signature over authTranscript(nonce, device_id, protocol). */
  signature: z.string().max(200),
  presence: presenceSchema,
});
export const daemonPresence = z.object({ type: z.literal("presence"), presence: presenceSchema });
export const daemonResult = z.object({
  type: z.literal("result"),
  id: z.string().min(8).max(64),
  ok: z.boolean(),
  /** Tool data on success. Small JSON only; never raw pages. */
  data: z.unknown().optional(),
  images: z.array(imageBlockSchema).max(8).optional(),
  error: errorPayloadSchema.optional(),
  duration_ms: z.number().nonnegative(),
});
export const daemonMessage = z.discriminatedUnion("type", [
  daemonAuth,
  daemonPresence,
  daemonResult,
]);
export type DaemonMessage = z.infer<typeof daemonMessage>;
export type DaemonResult = z.infer<typeof daemonResult>;

/** The exact bytes a daemon signs to authenticate a connection. */
export function authTranscript(nonce: string, deviceId: string, protocol: number): string {
  return `rainforest-device-auth-v1\n${nonce}\n${deviceId}\n${protocol}`;
}

/** Compare dotted numeric versions ("0.1.42"). Returns -1, 0 or 1. Non-numeric parts sort as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
