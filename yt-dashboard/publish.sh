#!/usr/bin/env bash
# Publishes channel-command.html to GitHub Pages in one shot.
# Requires: gh CLI, authenticated (gh auth status). Run from the folder containing channel-command.html.
set -euo pipefail

REPO="yt-dashboard"
USER=$(gh api user -q .login)

echo "→ Creating repo $USER/$REPO ..."
gh repo create "$REPO" --public -y >/dev/null 2>&1 || echo "  (repo already exists, continuing)"

TMP=$(mktemp -d)
cp channel-command.html "$TMP/index.html"
cd "$TMP"
git init -q && git checkout -qb main
git add index.html
git commit -qm "YouTube channel dashboard"
git remote add origin "https://github.com/$USER/$REPO.git"
git push -qu origin main --force

echo "→ Enabling GitHub Pages ..."
gh api "repos/$USER/$REPO/pages" -X POST -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || \
gh api "repos/$USER/$REPO/pages" -X PUT  -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true

echo ""
echo "============================================================"
echo "  Dashboard URL:   https://$USER.github.io/$REPO/"
echo "  OAuth origin:    https://$USER.github.io"
echo "============================================================"
echo "Pages can take 1-2 minutes to go live on first publish."
echo "Add the OAuth origin above in Google Cloud Console (see checklist)."
