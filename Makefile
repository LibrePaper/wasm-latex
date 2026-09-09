# The release pipeline, one target per step, in the order they run.
#
#   make vendor      fetch, verify and unpack the TeX Live tree -> vendor/ (network, 5 GB)
#   make test        every check that runs without Docker or network
#   make fontlist    generate xetexfontlist.txt with otfinfo  -> $(DIST)/xetexfontlist.txt
#   make bundles     pack the vendored texmf tree, plus the
#                    font list, into per-package bundles       -> wasm-build/dist/bundles
#   make format      dump the pdfTeX and XeTeX formats from
#                    the tree                                  -> wasm-build/dist/wasmtex-{pdftex,xetex}.fmt
#   make inventory   what the linker put in every engine    -> receipts/LINK-INVENTORY.*.json
#   make source      the corresponding-source archive        -> dist-source/
#   make publish-source TAG=engines-2026.1
#                    tag HEAD, create a GitHub Release, upload the archive; prints its URL
#   make stage SOURCE_URL=https://github.com/.../releases/download/<tag>/<archive>
#                    assemble staged/ and run the gate; prints the manifest SHA-256
#   make release TAG=engines-2026.1
#                    test, source, publish-source, stage, and annotate the release
#                    with the manifest hash — the whole chain, refusing early on a
#                    dirty tree or an existing tag; ends by printing the `make
#                    mirror` and `make push` commands rather than running them
#   make mirror MANIFEST_SHA256=<staged MANIFEST.json digest>
#                    build the mirror LibrePaper serves from staged/       -> mirror/
#   make push        write mirror/_headers and deploy it to Cloudflare (needs
#                    CLOUDFLARE_API_TOKEN)
#
# Engines themselves are built with Docker (see README); this file assumes
# wasm-build/dist already holds them.

TEXMF_DIST  ?= vendor/texlive-2026/texlive-20260301-texmf/texmf-dist
TEXMF_VAR   ?= vendor/texlive-2026/texmf-var
DIST        ?= wasm-build/dist
BUNDLES     ?= $(DIST)/bundles
STAGED      ?= staged
SOURCE_OUT  ?= dist-source
IMAGE       ?= librepaper-pdftex-wasm
FAMILIES    ?= pdftex bibtex bibtex8 makeindex xetex dvipdfm
MIRROR      ?= mirror
TEXMF_ARGS   = --texmf $(TEXMF_DIST) --texmf $(TEXMF_VAR)

.PHONY: help vendor test fontlist bundles format inventory source publish-source stage check release clean-staged mirror push

help:  ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*## /  /'

vendor:  ## Fetch, verify (signature and hash) and unpack the TeX Live tree, then generate the font map
	tools/vendor-texlive.sh

test:  ## Unit tests, pin check, and the resolver test
	node tools/check-pins.mjs
	node tools/stage-release.test.mjs
	node tools/build-bundles.test.mjs
	node tools/build-mirror.test.mjs
	node wasm-build/kpse-resolve.test.cjs
	node wasm-build/bundle-mode.test.cjs

fontlist:  ## Generate xetexfontlist.txt (otfinfo over every OpenType/TrueType font)
	node tools/xetex-fontlist.mjs $(TEXMF_ARGS) --out $(DIST)/xetexfontlist.txt

bundles: fontlist  ## Pack the texmf tree, plus the font list, into per-package bundles, with a receipt
	node tools/build-bundles.mjs $(TEXMF_ARGS) --out $(BUNDLES) \
	  --evidence receipts/BUNDLE-RECEIPT.texlive-2026.json \
	  --extra tex/xetex/fontlist/xetexfontlist.txt=$(DIST)/xetexfontlist.txt
	node tools/prune-bundles.mjs --dir $(BUNDLES)

format:  ## Dump the pdfTeX and XeTeX formats, smoke them, and check the bundle path resolves the same pdfTeX inputs
	node tools/build-format.mjs $(TEXMF_ARGS) --out $(DIST)/wasmtex-pdftex.fmt \
	  --evidence receipts/FORMAT-RECEIPT.pdftex-2026.json --smoke
	node tools/build-format.mjs $(TEXMF_ARGS) --bundles $(BUNDLES) --out /dev/null \
	  --expect-inputs receipts/FORMAT-RECEIPT.pdftex-2026.json --smoke
	node tools/build-format.mjs $(TEXMF_ARGS) --engine xetex --out $(DIST)/wasmtex-xetex.fmt \
	  --evidence receipts/FORMAT-RECEIPT.xetex-2026.json --smoke-both

inventory:  ## Link inventories for every built family
	@for f in $(FAMILIES); do \
	  node tools/link-inventory.mjs --family $$f --dist $(DIST) --quiet \
	    --out receipts/LINK-INVENTORY.$$f.json || exit 1; done

source:  ## The corresponding-source archive and its receipt; refuses a dirty build tree
	node tools/build-corresponding-source.mjs --dist $(DIST) --image $(IMAGE) --out $(SOURCE_OUT)/

publish-source:  ## Tag HEAD and upload the archive to a GitHub Release (needs TAG=)
	@test -n "$(TAG)" || { echo "usage: make publish-source TAG=engines-2026.1"; exit 2; }
	tools/release.sh publish-source "$(TAG)" "$(SOURCE_OUT)"

stage:  ## Assemble the release directory and run the gate (needs SOURCE_URL=)
	@test -n "$(SOURCE_URL)" || { echo "usage: make stage SOURCE_URL=https://.../source.tar.xz"; exit 2; }
	node tools/stage-release.mjs --dist $(DIST) --bundles $(BUNDLES) --out $(STAGED) --source-url "$(SOURCE_URL)"

check:  ## Re-run the gate on an existing staged directory
	node tools/check-release.mjs --dir $(STAGED)

release:  ## The whole chain: test, source, publish, stage, annotate (needs TAG=)
	@test -n "$(TAG)" || { echo "usage: make release TAG=engines-2026.1"; exit 2; }
	tools/release.sh preflight "$(TAG)"
	$(MAKE) test
	$(MAKE) inventory
	$(MAKE) source
	$(MAKE) publish-source TAG=$(TAG)
	$(MAKE) stage SOURCE_URL="$$(tools/release.sh source-url "$(TAG)" "$(SOURCE_OUT)")"
	tools/release.sh annotate "$(TAG)" "$(STAGED)"
	@# Publishing the mirror is deliberate, not automatic: review the staged
	@# manifest, then run these yourself.
	@HASH=$$(sha256sum $(STAGED)/MANIFEST.json | cut -d' ' -f1); \
	echo ""; \
	echo "Staged and annotated. Review $(STAGED)/MANIFEST.json, then:"; \
	echo "  make mirror MANIFEST_SHA256=$$HASH"; \
	echo "  make push"

clean-staged:  ## Remove the staged directory
	rm -rf $(STAGED)

mirror:  ## Build the mirror LibrePaper serves from a staged release (needs MANIFEST_SHA256=)
	@test -n "$(MANIFEST_SHA256)" || { echo "usage: make mirror MANIFEST_SHA256=<staged MANIFEST.json digest>"; exit 2; }
	node tools/build-mirror.mjs --staged $(STAGED) --sha256 "$(MANIFEST_SHA256)" --out $(MIRROR)
	node tools/check-mirror.mjs $(MIRROR)

push:  ## Write mirror/_headers and deploy the mirror to Cloudflare (needs CLOUDFLARE_API_TOKEN)
	@node tools/check-mirror.mjs $(MIRROR)
	@test -n "$$CLOUDFLARE_API_TOKEN" || { echo "CLOUDFLARE_API_TOKEN is not set; export it before make push"; exit 1; }
	@# Bundle tars and every engine file are digest-named and cached forever;
	@# manifest.json is the one release-describing file fetched by a bare
	@# name and must never be stale; bundles.json is the one bundling file
	@# fetched by a bare name too, and gets a short no-cache instead of
	@# no-store since it changes far less often than the manifest.
	@printf '/*\n  Cache-Control: public, max-age=31536000, immutable\n/manifest.json\n  Cache-Control: no-store\n/wasmtex/*/bundles/bundles.json\n  Cache-Control: no-cache\n' > $(MIRROR)/_headers
	@if command -v bunx >/dev/null 2>&1; then \
	  RUNNER="bunx wrangler"; \
	elif command -v npx >/dev/null 2>&1; then \
	  echo "push: bunx not found on PATH; using npx wrangler instead"; \
	  RUNNER="npx wrangler"; \
	else \
	  echo "push: neither bunx nor npx found on PATH; trying npx wrangler anyway"; \
	  RUNNER="npx wrangler"; \
	fi; \
	cd deploy && $$RUNNER deploy --assets "$(abspath $(MIRROR))"
	@echo "serve with: librepaper serve --latex https://librepaper-latex.<account>.workers.dev/"
