"""
Git-based version management for mc-webui.
Format: YYYY.MM.DD+<short_hash> (e.g., 2025.01.18+576c8ca9)
"""
import subprocess
import shlex
import os

VERSION_STRING = "0.0.0+unknown"
DOCKER_TAG = "0.0.0-unknown"


def subprocess_run(args):
    """Execute subprocess and return stripped stdout."""
    if not isinstance(args, (list, tuple)):
        args = shlex.split(args)
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        check=True,
        env={"PATH": os.environ.get("PATH", ""), "LC_ALL": "C"}
    )
    return proc.stdout.strip()


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

    return git_version, docker_tag


# Load version: frozen file takes priority, then git, then fallback
try:
    from app.version_frozen import VERSION_STRING, DOCKER_TAG
except ImportError:
    try:
        VERSION_STRING, DOCKER_TAG = get_git_version()
    except Exception:
        pass  # Keep defaults


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 2 and sys.argv[1] == "freeze":
        VERSION_STRING, DOCKER_TAG = get_git_version()
        code = f'''"""Frozen version - auto-generated, do not edit."""
VERSION_STRING = "{VERSION_STRING}"
DOCKER_TAG = "{DOCKER_TAG}"
'''
        path = os.path.join(os.path.dirname(__file__), "version_frozen.py")
        with open(path, "w", encoding="utf8") as f:
            f.write(code)
        print(f"Version frozen: {VERSION_STRING}")
    else:
        print(f'VERSION_STRING="{VERSION_STRING}"')
        print(f'DOCKER_TAG="{DOCKER_TAG}"')
