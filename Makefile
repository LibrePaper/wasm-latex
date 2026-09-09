# The release pipeline, one target per step, in the order they run.
#
#   make test        every check that runs without Docker or network
#   make bundles     pack the vendored texmf tree            -> wasm-build/dist/bundles
#   make format      dump the pdfTeX format from the tree    -> wasm-build/dist/wasmtex-pdftex.fmt
#   make inventory   what the linker put in every engine    -> receipts/LINK-INVENTORY.*.json
#   make source      the corresponding-source archive        -> dist-source/
#   make publish-source TAG=engines-2026.1
#                    tag HEAD, create a GitHub Release, upload the archive; prints its URL
#   make stage SOURCE_URL=https://github.com/.../releases/download/<tag>/<archive>
#                    assemble staged/ and run the gate; prints the manifest SHA-256
#   make release TAG=engines-2026.1
#                    test, source, publish-source, stage, and annotate the release
#                    with the manifest hash — the whole chain, refusing early on a
#                    dirty tree or an existing tag
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
TEXMF_ARGS   = --texmf $(TEXMF_DIST) --texmf $(TEXMF_VAR)

.PHONY: help test bundles format inventory source publish-source stage check release clean-staged

help:  ## List targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*## /  /'

test:  ## Unit tests, pin check, and the resolver test
	node tools/check-pins.mjs
	node tools/stage-release.test.mjs
	node tools/build-bundles.test.mjs
	node wasm-build/kpse-resolve.test.cjs
	@[ -f wasm-build/bundle-mode.test.cjs ] && node wasm-build/bundle-mode.test.cjs || true

bundles:  ## Pack the texmf tree into per-package bundles, with a receipt
	node tools/build-bundles.mjs $(TEXMF_ARGS) --out $(BUNDLES) \
	  --evidence receipts/BUNDLE-RECEIPT.texlive-2026.json
	node tools/prune-bundles.mjs --dir $(BUNDLES)

format:  ## Dump the pdfTeX format, smoke it, and check the bundle path resolves the same inputs
	node tools/build-format.mjs $(TEXMF_ARGS) --out $(DIST)/wasmtex-pdftex.fmt \
	  --evidence receipts/FORMAT-RECEIPT.pdftex-2026.json --smoke
	node tools/build-format.mjs $(TEXMF_ARGS) --bundles $(BUNDLES) --out /dev/null \
	  --expect-inputs receipts/FORMAT-RECEIPT.pdftex-2026.json --smoke

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

clean-staged:  ## Remove the staged directory
	rm -rf $(STAGED)
