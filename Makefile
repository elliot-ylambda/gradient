CLI := cli
PKG := gradient.md

.PHONY: test build publish-dry publish

test:
	cd $(CLI) && npm test

build:
	cd $(CLI) && npm run build

# Preview exactly what `make publish` would ship (tarball contents, version).
publish-dry:
	cd $(CLI) && npm publish --dry-run

# Publish cli/ to npm as gradient.md. prepublishOnly already runs
# test + build + smoke:bin, so a red suite aborts the publish.
publish:
	@npm whoami >/dev/null 2>&1 || { echo "not logged in to npm — run: npm login"; exit 1; }
	@[ -z "$$(git status --porcelain)" ] || { echo "working tree not clean — commit or stash first"; exit 1; }
	@cur=$$(node -p "require('./$(CLI)/package.json').version"); \
	live=$$(npm view $(PKG) version 2>/dev/null || echo none); \
	[ "$$cur" != "$$live" ] || { echo "$(PKG)@$$cur is already on npm — bump the version first"; exit 1; }
	cd $(CLI) && npm publish
	@v=$$(node -p "require('./$(CLI)/package.json').version"); \
	{ git tag "v$$v" 2>/dev/null && git push origin "v$$v"; } || echo "tag v$$v already exists — skipping tag"
