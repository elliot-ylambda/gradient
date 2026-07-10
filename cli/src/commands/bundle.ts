import { buildBundle, type BundleResult } from "../core/bundle.js";

export async function bundleCommand(
  projectDir: string,
  name: string,
  opts: { withHooks?: boolean; home?: string } = {},
): Promise<BundleResult> {
  return buildBundle(projectDir, name, opts);
}
