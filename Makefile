CLI := cli
PKG := gradient.md

.PHONY: test build publish-dry publish release-check

test:
	cd $(CLI) && npm test

build:
	cd $(CLI) && npm run build

# Preview exactly what `make publish` would ship (tarball contents, version).
publish-dry:
	cd $(CLI) && npm publish --dry-run

# Verify the already-published version is aligned across npm, GitHub Releases,
# and the deployed marketing site. Run after completing every release.
release-check:
	node scripts/check-release-state.mjs

# Release cli/ as gradient.md: publish to npm, push the v<version> tag, and
# create the GitHub release with the exact registry tarball attached.
# prepublishOnly runs test + build + smoke:bin, so a red suite aborts.
# Guarded: refuses when npm or gh is unauthenticated, the tree is dirty, or
# HEAD is not origin/main's tip (a stale checkout once shipped the wrong bits).
# Convergent: rerunning completes whichever steps a failed run left missing.
publish:
	@npm whoami >/dev/null 2>&1 || { echo "not logged in to npm — run: npm login"; exit 1; }
	@gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated — run: gh auth login"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "working tree not clean — commit or stash first"; exit 1; }
	@git fetch -q origin main && \
	[ "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" ] || { echo "HEAD is not origin/main's tip — merge to main first; releases ship only main"; exit 1; }
	@set -e; \
	v=$$(node -p "require('./$(CLI)/package.json').version"); \
	live=$$(npm view $(PKG) version 2>/dev/null || echo none); \
	if [ "$$v" = "$$live" ] && git ls-remote --exit-code origin "refs/tags/v$$v" >/dev/null 2>&1 && gh release view "v$$v" >/dev/null 2>&1; then \
		echo "$(PKG)@$$v is already fully released — bump the version first"; exit 1; \
	fi; \
	if [ "$$v" != "$$live" ]; then (cd $(CLI) && npm publish); fi; \
	git rev-parse -q --verify "refs/tags/v$$v" >/dev/null || git tag "v$$v"; \
	git push origin "v$$v"; \
	if ! gh release view "v$$v" >/dev/null 2>&1; then \
		tmp=$$(mktemp -d); \
		for i in 1 2 3 4 5; do (cd "$$tmp" && npm pack "$(PKG)@$$v" --silent) >/dev/null 2>&1 && break; echo "registry not serving $$v yet — retrying ($$i/5)"; sleep 4; done; \
		[ -f "$$tmp/$(PKG)-$$v.tgz" ] || { echo "could not fetch the registry tarball for $$v"; exit 1; }; \
		gh release create "v$$v" --title "gradient $$v" --generate-notes "$$tmp/$(PKG)-$$v.tgz"; \
		rm -rf "$$tmp"; \
	fi; \
	echo "$(PKG)@$$v released: npm + v$$v tag + GitHub release"; \
	echo "next: update gradient-web, then verify with: make release-check"
