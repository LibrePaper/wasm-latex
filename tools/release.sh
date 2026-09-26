#!/usr/bin/env bash
# The one step of the pipeline that publishes: put the corresponding-source
# archive on a GitHub Release so the shipped SOURCE.md can point at it.
#
#   tools/release.sh preflight       <tag>                 clean tree, tag unused, gh signed in
#   tools/release.sh commit-receipt                        commit what make inventory and make source wrote under receipts/
#   tools/release.sh publish-source  <tag> [dist-source]   tag HEAD, create the release, upload
#   tools/release.sh source-url      <tag> [dist-source]   print the download URL for the archive
#   tools/release.sh annotate        <tag> [staged]        add the manifest hash to the release notes
#
# Everything here is deliberately not in check-release.mjs: the gate decides
# whether a directory may be published, this decides that it is. It refuses a
# dirty tree, an existing tag, and an archive built from another commit, so the
# URL it prints always names the source of the commit it tags.

set -euo pipefail

cmd=${1:-}; tag=${2:-}
repo=$(git config --get remote.origin.url | sed -E 's#.*github.com[:/]##; s#\.git$##')
head=$(git rev-parse HEAD)
short=${head:0:12}

die() { echo "release: $*" >&2; exit 1; }
need_tag() { [ -n "$tag" ] || die "a tag is required, e.g. engines-2026.1"; }

# The archive is built from the commit the receipt names, and the receipt is
# then committed on top, so HEAD is normally one commit past the archive. That
# is fine as long as the difference is confined to receipts/: the source the
# binaries came from is identical. Anything else and the archive is stale.
built_from() {
  node -e 'process.stdout.write(require("./receipts/SOURCE-RECEIPT.json").repositoryCommit || "")'
}
check_receipt_matches_head() {
  local from; from=$(built_from)
  [ -n "$from" ] || die "receipts/SOURCE-RECEIPT.json names no commit; run: make source"
  if [ "$from" != "$head" ]; then
    local changed; changed=$(git diff --name-only "$from" "$head" | grep -v '^receipts/' || true)
    [ -z "$changed" ] || die "HEAD differs from the archive's commit ${from:0:12} outside receipts/ ($changed); run: make source"
  fi
}
archive_for() {  # <dist-source dir> -> path of the archive the receipt names
  local dir=${1:-dist-source}
  local from; from=$(built_from)
  local f="$dir/librepaper-wasm-latex-${from:0:12}-source.tar.xz"
  [ -f "$f" ] || die "no archive for ${from:0:12} in $dir; run: make source"
  [ -f "$f.sha256" ] || die "missing $f.sha256"
  echo "$f"
}

case "$cmd" in
  preflight)
    need_tag
    [ -z "$(git status --porcelain)" ] || die "the working tree is not clean; commit first"
    git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists; tags are never moved, pick a new one"
    git fetch -q origin "refs/tags/$tag" 2>/dev/null && die "tag $tag already exists on origin"
    gh auth status >/dev/null 2>&1 || die "gh is not signed in; run: gh auth login"
    echo "preflight ok: HEAD $short, tag $tag unused, gh signed in, repo $repo"
    ;;

  commit-receipt)
    # After make inventory and make source: commit every receipt they
    # rewrote, so the tag names the evidence of what it publishes. Nothing to
    # do when none changed.
    git diff --quiet -- receipts/ && { echo "receipts unchanged"; exit 0; }
    from=$(built_from)
    git add receipts/
    git commit -q -m "Record the corresponding source and inventories for ${from:0:12}" -m "Claude-Session: https://claude.ai/code/session_01JACqCUhphavt1ZsKdgH9UG"
    echo "committed receipts for ${from:0:12}: $(git show --stat --format= HEAD | tail -1)"
    ;;

  publish-source)
    need_tag
    "$0" preflight "$tag" >/dev/null
    check_receipt_matches_head
    archive=$(archive_for "${3:-dist-source}")
    sha=$(cut -d' ' -f1 < "$archive.sha256")
    receipt=$(node -e 'console.log(require("./receipts/SOURCE-RECEIPT.json").sha256)')
    [ "$sha" = "$receipt" ] || die "archive hash $sha does not match receipts/SOURCE-RECEIPT.json ($receipt)"
    git tag -a "$tag" -m "Engine release $tag, corresponding source sha256 $sha"
    git push -q origin main
    git push -q origin "refs/tags/$tag"
    gh release create "$tag" "$archive" "$archive.sha256" \
      --repo "$repo" --title "$tag" --notes "$(cat <<NOTES
Corresponding source for the WebAssembly TeX engines built at $head.

    $(basename "$archive")
    sha256 $sha

Unpack it and follow REBUILD.md to rebuild the engines, or RELINK.md to
substitute a modified LGPL library. The staged release that ships these
engines names this URL in its SOURCE.md and MANIFEST.json.
NOTES
)"
    echo "published: $("$0" source-url "$tag" "${3:-dist-source}")"
    ;;

  source-url)
    need_tag
    archive=$(archive_for "${3:-dist-source}")
    echo "https://github.com/$repo/releases/download/$tag/$(basename "$archive")"
    ;;

  annotate)
    need_tag
    staged=${3:-staged}
    [ -f "$staged/MANIFEST.json" ] || die "no $staged/MANIFEST.json; run: make stage"
    node -e 'const m=require(process.argv[1]); if(m.releaseGate!=="passed"){console.error("release: the gate did not pass; not annotating");process.exit(1)}' "$PWD/$staged/MANIFEST.json"
    manifest=$(sha256sum "$staged/MANIFEST.json" | cut -d' ' -f1)
    notes=$(gh release view "$tag" --repo "$repo" --json body -q .body)
    gh release edit "$tag" --repo "$repo" --notes "$notes

Staged release MANIFEST.json sha256 (the value LibrePaper imports with
LATEX_RELEASE_SHA256=):

    $manifest"
    echo "manifest $manifest recorded on release $tag"
    ;;

  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
