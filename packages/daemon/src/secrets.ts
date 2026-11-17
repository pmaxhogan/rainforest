import { z } from "zod";
import { readTextIfExists, writeSecretFile, type SecretWriteDeps } from "./fsutil.ts";
import type { AppPaths } from "./paths.ts";

/** secrets.json: the extension token and the optional update token. Mode 0600. */
export const secretsSchema = z.looseObject({
  extension_token: z.string().min(16).max(512),
  update_token: z.string().min(1).max(512).optional(),
});

export type Secrets = z.infer<typeof secretsSchema>;

export function loadSecrets(paths: AppPaths): Secrets | null {
  const text = readTextIfExists(paths.secretsFile);
  if (text === null) return null;
  const result = secretsSchema.safeParse(JSON.parse(text));
  return result.success ? result.data : null;
}

export async function saveSecrets(
  paths: AppPaths,
  secrets: Secrets,
  deps: SecretWriteDeps,
): Promise<void> {
  const parsed = secretsSchema.parse(secrets);
  await writeSecretFile(paths.secretsFile, `${JSON.stringify(parsed, null, 2)}\n`, deps);
}
