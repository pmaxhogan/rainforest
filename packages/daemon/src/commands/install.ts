import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compareVersions } from "@rainforest/core";
import { atomicWriteFile, ensureDir } from "../fsutil.ts";
import { linkDevVersion, listVersions, readCurrent, writeCurrent } from "../layout.ts";
import { versionDir } from "../paths.ts";
import { IS_BUNDLED } from "../version.ts";
import type { CliContext } from "./context.ts";

export interface InstallOptions {
  link_dev: boolean;
  no_start: boolean;
}

/** `rainforestd install`: lay out the app dir, drop the stable launcher, register autostart. */
export async function installCommand(ctx: CliContext, options: InstallOptions): Promise<number> {
  const { paths, io } = ctx;
  ensureDir(paths.root);
  ensureDir(paths.versionsDir);
  ensureDir(paths.logsDir);

  atomicWriteFile(paths.launcherFile, readFileSync(ctx.launcherSource));
  io.out(`launcher: ${paths.launcherFile}`);

  if (options.link_dev) {
    const name = linkDevVersion(paths, ctx.mainEntry);
    io.out(`linked dev version "${name}" to this checkout`);
  }
  if (IS_BUNDLED) {
    // First install from an unpacked release: copy this release into versions/<v>/ and
    // make it current unless a newer version is already active.
    const source = dirname(ctx.mainEntry);
    const target = versionDir(paths, ctx.version);
    if (resolve(source) !== resolve(target)) {
      if (!existsSync(target)) cpSync(source, target, { recursive: true });
      io.out(`installed version ${ctx.version}`);
    }
    const active = readCurrent(paths);
    if (active === null || compareVersions(ctx.version, active) > 0)
      writeCurrent(paths, ctx.version);
  }
  const current = readCurrent(paths);
  if (current === null) {
    io.err(
      "warning: no active version. The service will exit until one is installed " +
        "(`rainforestd update`, or `rainforestd install --link-dev` from a source checkout).",
    );
  } else {
    io.out(`active version: ${current} (installed: ${listVersions(paths).join(", ")})`);
  }

  const service = ctx.makeServiceManager();
  await service.install({ start: !options.no_start });
  io.out(`autostart registered (${service.kind})${options.no_start ? "" : " and started"}`);
  return 0;
}

export async function uninstallCommand(ctx: CliContext): Promise<number> {
  const service = ctx.makeServiceManager();
  await service.uninstall();
  ctx.io.out(`autostart removed (${service.kind}); config, keys and logs were left in place`);
  return 0;
}
