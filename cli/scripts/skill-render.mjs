/**
 * Render a Claude Code plugin SKILL.md as its Codex counterpart.
 *
 * The plugin's three SKILL.md files are the authored source. Maintaining a
 * second hand-written set for Codex would drift, and the drift would be
 * invisible: a skill is prose until an agent runs it, so a stale command in one
 * copy looks exactly like a correct one until it fails in a user's session.
 *
 * Everything that differs is a fact about where the skill lives, not about what
 * it does — which is why one source can serve both.
 */

/**
 * Claude Code namespaces a plugin's skills for you (`gradient:optimize`).
 * `~/.agents/skills` is a flat, shared namespace, so a skill called `optimize`
 * there would be a landgrab — the Codex copies carry the prefix themselves.
 */
export const codexName = name => `gradient-${name}`;

export const SKILLS = ["optimize", "report", "features"];

/**
 * Keys Claude Code understands and Codex does not. gradient reports a skill
 * that carries one of these to a Codex assistant as a `non-portable-key`
 * problem (see core/surface.ts), and a tool that ships an artifact it would
 * flag has no standing to flag anyone else's. The behaviour the dropped key
 * buys — never toggling a background feature unasked — is stated in the body,
 * which is the only place Codex would read it anyway.
 */
const CLAUDE_ONLY_KEYS = ["disable-model-invocation", "user-invocable", "disallowed-tools"];

export function forCodex(body, name) {
  const runner = `node "$HOME/.agents/skills/${codexName(name)}/bin/gradient.mjs"`;
  const swaps = [
    [new RegExp(`^name: ${name}$`, "m"), `name: ${codexName(name)}`, true],
    // `${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code alone. "$HOME" is
    // quoted because a home directory may contain a space.
    [/node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/gradient\.mjs"/g, runner, true],
    ...CLAUDE_ONLY_KEYS.map(key => [new RegExp(`^${key}:[^\\n]*\\n`, "m"), "", false]),
    // Present only in the two skills that say what a startup failure means.
    [
      /If the command fails to start, the plugin install is broken — tell the user to\nreinstall the gradient plugin\. Never fall back to a PATH-installed gradient\./g,
      `If the command fails to start, this skill directory is incomplete — tell the\n` +
      `user to re-copy skills/${codexName(name)} from the gradient repository.\n` +
      `Never look for a gradient anywhere else on the system.`,
      false,
    ],
  ];

  let out = body;
  // Compare the result rather than probing with .test(): a /g regex carries
  // lastIndex between calls, so testing first quietly changes what replace sees.
  for (const [pattern, replacement, required] of swaps) {
    const next = out.replace(pattern, replacement);
    if (required && next === out) throw new Error(`skill ${name}: nothing matched ${pattern}`);
    out = next;
  }
  return out;
}
