# The release pipeline, one target per step, in the order they run.
#
#   make vendor      fetch, verify and unpack the TeX Live tree -> vendor/ (network, 5 GB)
#   make test        every check that runs without Docker or network
#   make fontlist    generate xetexfontlist.txt with otfinfo  -> $(DIST)/xetexfontlist.txt
#   make bundles     pack the vendored texmf tree, plus the
#                    font list, into per-package bundles       -> wasm-build/dist/bundles
#   make format      dump the pdfTeX and XeTeX formats from
#                    the tree                                  -> wasm-build/dist/{pdftex,xetex}.fmt
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
#   make mirror      build the mirror LibrePaper serves from staged/       -> mirror/
#                    (MANIFEST_SHA256=<digest> pins a reviewed hash instead)
#   make push        write mirror/_headers and deploy it to Cloudflare (needs
#                    CLOUDFLARE_API_TOKEN; `make secrets` opens a shell that has it)
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
FAMILIES    ?= pdftex bibtex bibtex8 biber makeindex xetex dvipdfm
MIRROR      ?= mirror
# The Cloudflare Worker that is nothing but these files. Two settings, so they
# live here as flags rather than in a wrangler.toml of their own. Deployed
# under the librepaper account's workers.dev subdomain, this reaches it at
# https://latex.librepaper.workers.dev/.
WORKER      ?= latex
COMPAT_DATE ?= 2026-09-01
TEXMF_ARGS   = --texmf $(TEXMF_DIST) --texmf $(TEXMF_VAR)
# The Cloudflare token `make push` needs lives sops-encrypted in the
# application's deploy/keys.yaml, one file for every LibrePaper repo, and is
# reached through the sibling checkout.
KEYS        ?= ../librepaper/deploy/keys.yaml

.PHONY: help vendor test fontlist bundles format inventory source publish-source stage check release clean-staged mirror push secrets

BIBER_IMAGE ?= librepaper-biber-wasm-experimental
BIBER_OUT ?= $(DIST)
.DEFAULT_GOAL := help
.PHONY: biber-vendor-check biber-build biber-smoke biber-browser-check

biber-vendor-check:  ## Verify the pinned TeXlyre Biber source snapshot
	node tools/check-biber-vendor.mjs

biber-build: biber-vendor-check  ## Build and smoke Biber WASM with Docker (network required)
	docker build -f wasm-build/Dockerfile.biber -t $(BIBER_IMAGE) .
	mkdir -p "$(BIBER_OUT)"
	docker run --rm -v "$(abspath $(BIBER_OUT)):/out" $(BIBER_IMAGE)

biber-smoke:  ## Run the Node smoke check on existing Biber artifacts
	node wasm-build/biber-smoke.cjs "$(BIBER_OUT)"

biber-browser-check:  ## Exercise pdfTeX and Biber in Chromium (needs built engines, bundles, pdftotext)
	node wasm-build/biber-browser-check.mjs $(BIBER_CHECK_ARGS)

help:  ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*## /  /'

vendor:  ## Fetch, verify (signature and hash) and unpack the TeX Live tree, then generate the font map
	tools/vendor-texlive.sh

test:  ## Unit tests, pin check, and the resolver test
	node tools/check-biber-vendor.mjs
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
	node tools/build-format.mjs $(TEXMF_ARGS) --out $(DIST)/pdftex.fmt \
	  --evidence receipts/FORMAT-RECEIPT.pdftex-2026.json --smoke
	node tools/build-format.mjs $(TEXMF_ARGS) --bundles $(BUNDLES) --out /dev/null \
	  --expect-inputs receipts/FORMAT-RECEIPT.pdftex-2026.json --smoke
	node tools/build-format.mjs $(TEXMF_ARGS) --engine xetex --out $(DIST)/xetex.fmt \
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
	tools/release.sh commit-receipt
	$(MAKE) publish-source TAG=$(TAG)
	$(MAKE) stage SOURCE_URL="$$(tools/release.sh source-url "$(TAG)" "$(SOURCE_OUT)")"
	tools/release.sh annotate "$(TAG)" "$(STAGED)"
	@# Publishing the mirror is deliberate, not automatic: review the staged
	@# manifest, then run these yourself.
	@HASH=$$(sha256sum $(STAGED)/MANIFEST.json | cut -d' ' -f1); \
	echo ""; \
	echo "Staged and annotated. Review $(STAGED)/MANIFEST.json, then:"; \
	echo "  make mirror        # staged manifest $$HASH"; \
	echo "  make push"

clean-staged:  ## Remove the staged directory
	rm -rf $(STAGED)

mirror:  ## Build the mirror LibrePaper serves from staged/ (MANIFEST_SHA256= to pin a reviewed hash)
	@test -f $(STAGED)/MANIFEST.json || { echo "no $(STAGED)/MANIFEST.json; run make release TAG=<tag> (or make stage SOURCE_URL=<url>) first"; exit 2; }
	@# The hash is read from the staged manifest when not given: this repository
	@# staged it, so there is no second party whose review the hash would carry.
	@HASH="$(MANIFEST_SHA256)"; [ -n "$$HASH" ] || HASH=$$(sha256sum $(STAGED)/MANIFEST.json | cut -d' ' -f1); \
	echo "mirror: staged manifest $$HASH"; \
	node tools/build-mirror.mjs --staged $(STAGED) --sha256 "$$HASH" --out $(MIRROR)
	node tools/check-mirror.mjs $(MIRROR)

push:  ## Write mirror/_headers and deploy the mirror to Cloudflare (needs CLOUDFLARE_API_TOKEN)
	@node tools/check-mirror.mjs $(MIRROR)
	@test -n "$$CLOUDFLARE_API_TOKEN" || { echo "CLOUDFLARE_API_TOKEN is not set; run make push inside \`make secrets\`, or: sops exec-env $(KEYS) 'make push'"; exit 1; }
	@# Bundle tars and every engine file are digest-named and cached forever;
	@# manifest.json is the one release-describing file fetched by a bare
	@# name and must never be stale; bundles.json is the one bundling file
	@# fetched by a bare name too, and gets a short no-cache instead of
	@# no-store since it changes far less often than the manifest.
	@# Cloudflare merges every matching rule, so the two exceptions detach the
	@# header the /* rule set before setting their own. The files are public
	@# and digest-named; a browser on any origin may fetch them.
	@printf '/*\n  Cache-Control: public, max-age=31536000, immutable\n  Access-Control-Allow-Origin: *\n/manifest.json\n  ! Cache-Control\n  Cache-Control: no-store\n/engines/*/bundles/bundles.json\n  ! Cache-Control\n  Cache-Control: no-cache\n' > $(MIRROR)/_headers
	@if command -v bunx >/dev/null 2>&1; then \
	  RUNNER="bunx wrangler"; \
	elif command -v npx >/dev/null 2>&1; then \
	  echo "push: bunx not found on PATH; using npx wrangler instead"; \
	  RUNNER="npx wrangler"; \
	else \
	  echo "push: neither bunx nor npx found on PATH; trying npx wrangler anyway"; \
	  RUNNER="npx wrangler"; \
	fi; \
	$$RUNNER deploy --name $(WORKER) --compatibility-date $(COMPAT_DATE) --assets "$(abspath $(MIRROR))"
	@echo "serve with: librepaper serve --latex https://latex.librepaper.workers.dev/"

# A target cannot export into the shell that ran make, so this opens a
# subshell with the keys decrypted in its environment; exit it to drop them.
# For one command instead of a shell: sops exec-env $(KEYS) '<command>'
secrets:  ## Open a shell with the sops-encrypted keys in its environment
	@test -f $(KEYS) || { echo "no $(KEYS) -- clone LibrePaper/librepaper beside this repo, or set KEYS="; exit 1; }
	@test -t 0 || { echo "make secrets opens an interactive subshell and needs a terminal" >&2; exit 2; }
	@echo "$(KEYS) is loaded in this shell; exit to drop it"
	@sops exec-env $(KEYS) "$${SHELL:-/bin/sh}"
