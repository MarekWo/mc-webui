#!/bin/bash
# Tag the current release and publish it on GitHub.
#
# Run on `main`, after merging `dev`. Reads the release number from VERSION
# and the release notes from the matching docs/whatsnew.md section, so there
# is exactly one place to edit each of them.
#
#   ./scripts/release.sh            # tag + GitHub release
#   ./scripts/release.sh --dry-run  # show what would happen, change nothing

set -e

DRY_RUN=false
[ "$1" = "--dry-run" ] && DRY_RUN=true

cd "$(dirname "$0")/.."

info()    { echo -e "\033[0;34m[*]\033[0m $1"; }
success() { echo -e "\033[0;32m[+]\033[0m $1"; }
error()   { echo -e "\033[0;31m[!]\033[0m $1" >&2; }

VERSION=$(tr -d ' \t\r\n' < VERSION)
TAG="v${VERSION}"

if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    error "VERSION must be MAJOR.MINOR.PATCH, got '${VERSION}'"
    exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
    error "Releases are cut from main, but you are on '${BRANCH}'"
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    error "Working tree is dirty - commit or stash first"
    exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
    error "Tag ${TAG} already exists - bump VERSION before releasing"
    exit 1
fi

# Release notes: the whatsnew.md section headed "## <version> - <date>",
# up to the next "## " heading
NOTES=$(awk -v ver="$VERSION" '
    $0 ~ "^## " ver "( |$|—)" { found = 1; next }
    found && /^## / { exit }
    found { print }
' docs/whatsnew.md | sed -e 's/^---$//' | awk 'NF || printed { print; printed = 1 }')

if [ -z "$(echo "$NOTES" | tr -d '[:space:]')" ]; then
    error "No release notes for ${VERSION} in docs/whatsnew.md"
    error "Expected a section headed: ## ${VERSION} - YYYY-MM-DD"
    exit 1
fi

info "Release ${TAG} on $(git rev-parse --short HEAD)"
echo "----------------------------------------"
echo "$NOTES"
echo "----------------------------------------"

if [ "$DRY_RUN" = true ]; then
    info "Dry run - no tag created, nothing published"
    exit 0
fi

git tag -a "$TAG" -m "mc-webui ${VERSION}"
success "Tagged ${TAG}"

git push origin "$TAG"
success "Pushed ${TAG}"

if command -v gh >/dev/null 2>&1; then
    echo "$NOTES" | gh release create "$TAG" --title "mc-webui ${VERSION}" --notes-file -
    success "Published GitHub release ${TAG}"
else
    info "gh CLI not found - create the release manually at:"
    info "  https://github.com/MarekWo/mc-webui/releases/new?tag=${TAG}"
fi
