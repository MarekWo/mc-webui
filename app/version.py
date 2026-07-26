"""
Version management for mc-webui.

Two identities, on purpose:
- RELEASE_VERSION - the human-facing release number (SemVer, e.g. 2.1.0),
  read from the VERSION file at the repo root. This is what users quote.
- VERSION_STRING  - the exact build, derived from git as
  YYYY.MM.DD+<short_hash> (e.g. 2025.01.18+576c8ca9). This is what pins a
  deployment down for debugging, and what the update checker compares.
"""
import subprocess
import shlex
import os

RELEASE_VERSION = "0.0.0"
VERSION_STRING = "0.0.0+unknown"
DOCKER_TAG = "0.0.0-unknown"
GIT_BRANCH = "unknown"


def get_release_version():
    """Read the release number from the VERSION file next to the app package."""
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "VERSION"
    )
    try:
        with open(path, encoding="utf8") as f:
            return f.read().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def subprocess_run(args):
    """Execute subprocess and return stripped stdout."""
    if not isinstance(args, (list, tuple)):
        args = shlex.split(args)
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        check=True,
        env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), "LC_ALL": "C"}
    )
    return proc.stdout.strip()


def get_git_branch():
    """Get current git branch name."""
    try:
        # Try to get branch name
        branch = subprocess_run("git rev-parse --abbrev-ref HEAD")
        if branch == "HEAD":
            # Detached HEAD state - try to get branch from remote
            branch = subprocess_run("git branch -r --contains HEAD")
            if branch:
                # Parse "origin/branch" format
                branch = branch.split("/")[-1].split("\n")[0].strip()
            else:
                branch = "detached"
        return branch
    except subprocess.CalledProcessError:
        return "unknown"


def get_git_version():
    """Get version from git commit date and hash."""
    # Get date (YYYY.MM.DD) and short hash
    git_version = subprocess_run(
        r"git show -s --date=format:%Y.%m.%d --format=%cd+%h"
    )
    # Keep full ISO format (with leading zeros)
    docker_tag = git_version.replace("+", "-")

    # Check for uncommitted changes (ignore .env and technotes/)
    try:
        subprocess_run("git diff --quiet -- . :!*.env :!.env :!technotes/")
    except subprocess.CalledProcessError as e:
        if e.returncode == 1:
            git_version += "+dirty"

    # Get branch name
    git_branch = get_git_branch()

    return git_version, docker_tag, git_branch


# Load version: frozen file takes priority, then git, then fallback.
# The release number comes from the VERSION file either way - a frozen file
# written before releases existed simply has no RELEASE_VERSION to override it.
RELEASE_VERSION = get_release_version()
try:
    from app import version_frozen
    VERSION_STRING = version_frozen.VERSION_STRING
    DOCKER_TAG = version_frozen.DOCKER_TAG
    GIT_BRANCH = version_frozen.GIT_BRANCH
    RELEASE_VERSION = getattr(version_frozen, "RELEASE_VERSION", None) or RELEASE_VERSION
except ImportError:
    try:
        VERSION_STRING, DOCKER_TAG, GIT_BRANCH = get_git_version()
    except Exception:
        pass  # Keep defaults


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 2 and sys.argv[1] == "freeze":
        VERSION_STRING, DOCKER_TAG, GIT_BRANCH = get_git_version()
        RELEASE_VERSION = get_release_version()
        code = f'''"""Frozen version - auto-generated, do not edit."""
RELEASE_VERSION = "{RELEASE_VERSION}"
VERSION_STRING = "{VERSION_STRING}"
DOCKER_TAG = "{DOCKER_TAG}"
GIT_BRANCH = "{GIT_BRANCH}"
'''
        path = os.path.join(os.path.dirname(__file__), "version_frozen.py")
        with open(path, "w", encoding="utf8") as f:
            f.write(code)
        print(f"Version frozen: {RELEASE_VERSION} ({VERSION_STRING}, {GIT_BRANCH})")
    elif len(sys.argv) >= 2 and sys.argv[1] == "release":
        # Plain release number, for scripts/release.sh and CI
        print(RELEASE_VERSION)
    else:
        print(f'RELEASE_VERSION="{RELEASE_VERSION}"')
        print(f'VERSION_STRING="{VERSION_STRING}"')
        print(f'DOCKER_TAG="{DOCKER_TAG}"')
        print(f'GIT_BRANCH="{GIT_BRANCH}"')
