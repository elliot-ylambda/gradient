CLI  := cli
REPO := elliot-ylambda/gradient

.PHONY: test build artifacts publish-dry publish release-check

test:
	cd $(CLI) && npm test

build:
	cd $(CLI) && npm run build

# Rebuild every committed artifact: the plugin bundle and the three copy-install
# skill directories. gradient ships as files in this repository, so these are
# the release — a stale bundle here is a stale release.
artifacts:
	cd $(CLI) && npm run build:plugin

# Show what a release would ship, and whether the committed artifacts are
# current. Rebuilds, then reports any file the build changed.
publish-dry: artifacts
	@git status --porcelain plugin skills | sed 's/^/  stale: /' || true
	@[ -z "$$(git status --porcelain plugin skills)" ] && echo "committed artifacts are current" || \
		{ echo "commit the rebuilt artifacts before releasing"; exit 1; }
	@v=$$(node -p "require('./$(CLI)/package.json').version"); \
	echo "would release v$$v: plugin/ + skills/gradient-* (tag v$$v, GitHub release)"

# Release: tag, and publish a GitHub release carrying the skill directories as
# one tarball so a Codex user can install without cloning. There is no package
# registry in this path — the Claude Code plugin is served from this repository
# by the marketplace, and the skills are copied from it.
# Guarded: refuses when gh is unauthenticated, the tree is dirty, HEAD is not
# origin/main's tip, or the artifacts on disk do not match a fresh build.
# Convergent: rerunning completes whichever steps a failed run left missing.
publish: artifacts
	@gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated — run: gh auth login"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "working tree not clean (rebuilt artifacts differ, or uncommitted work) — commit or stash first"; exit 1; }
	@git fetch -q origin main && \
	[ "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" ] || { echo "HEAD is not origin/main's tip — merge to main first; releases ship only main"; exit 1; }
	@set -e; \
	v=$$(node -p "require('./$(CLI)/package.json').version"); \
	if git ls-remote --exit-code origin "refs/tags/v$$v" >/dev/null 2>&1 && gh release view "v$$v" >/dev/null 2>&1; then \
		echo "v$$v is already fully released — bump the version first"; exit 1; \
	fi; \
	git rev-parse -q --verify "refs/tags/v$$v" >/dev/null || git tag "v$$v"; \
	git push origin "v$$v"; \
	if ! gh release view "v$$v" >/dev/null 2>&1; then \
		tmp=$$(mktemp -d); \
		tar -czf "$$tmp/gradient-skills.tar.gz" -C skills gradient-optimize gradient-report gradient-features; \
		gh release create "v$$v" --title "gradient $$v" --generate-notes "$$tmp/gradient-skills.tar.gz"; \
		rm -rf "$$tmp"; \
	fi; \
	echo "v$$v released: tag + GitHub release with the skill tarball"; \
	echo "next: update gradient-web, then verify with: make release-check"

# Verify the released version is aligned across GitHub Releases and the
# deployed marketing site. Run after completing every release.
release-check:
	node scripts/check-release-state.mjs
