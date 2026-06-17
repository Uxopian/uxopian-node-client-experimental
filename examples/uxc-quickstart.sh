#!/usr/bin/env bash
# uxc quickstart — from a raw FlowerDocs/Uxopian AI URL + scope to browsing, installing, and
# publishing marketplace addons. This is a REFERENCE: copy the lines you need, fill in <…>.
# It is NOT meant to run top-to-bottom (publish needs a package dir; some steps write to servers).

# ─────────────────────────────────────────────────────────────────────────────
# 0. Inputs — the only things that identify an instance are its URL + SCOPE.
#    One (url, scope) pair = one instance, and serves BOTH surfaces:
#      FlowerDocs Core REST : <URL>/core
#      Uxopian AI gateway   : <URL>/gui/plugins/<SCOPE>/gateway/uxopian-ai
# ─────────────────────────────────────────────────────────────────────────────
URL="https://iris.demos.uxopian.com"     # FlowerDocs base URL (no trailing slash)
SCOPE="IRIS"                             # scope id
USER="system"                            # Core user
PASSWORD="<core-password>"               # Core password

# Marketplace (separate credential store): publish endpoint + your per-maintainer API key.
MP_URL="<MARKETPLACE_PUBLISH_URL>"
MP_TOKEN="<uxmk_…>"                      # ask a marketplace admin to mint one

# uxc launcher. Either PATH-link it once and use `uxc`, or use this variable.
#   ln -s "$PWD/bin/uxc.mjs" /usr/local/bin/uxc   (run from the repo root)
UXC="uxc"   # PATH-linked above, or: node /path/to/repo/bin/uxc.mjs

# ─────────────────────────────────────────────────────────────────────────────
# 1. Register the instance as a target. The NAME ("inst") is your local alias —
#    you choose it; url+scope are the real inputs. Stored in ~/.uxopian/targets.json.
# ─────────────────────────────────────────────────────────────────────────────
$UXC target add inst --url "$URL" --scope "$SCOPE" --user "$USER" --password "$PASSWORD" --default
$UXC target ls                  # list targets; * marks the default
$UXC doctor                     # connectivity gauntlet (add --roundtrip for the full echo test)

# ─────────────────────────────────────────────────────────────────────────────
# 2. Connect the marketplace (browse / install / publish all use this).
# ─────────────────────────────────────────────────────────────────────────────
$UXC mp login --url "$MP_URL" --token "$MP_TOKEN" \
  --name "Your Name" --email you@example.com --verify

# ─────────────────────────────────────────────────────────────────────────────
# 3. Browse the marketplace.
# ─────────────────────────────────────────────────────────────────────────────
$UXC mp ls
$UXC mp ls --category contract-intelligence --product uxopian-ai --compat 2025.4
$UXC mp categories
$UXC mp show contract-management --catalog       # listing + version history + object catalog
$UXC mp versions contract-management

# ─────────────────────────────────────────────────────────────────────────────
# 4. Install an addon onto THIS instance (download → verify sha256 → deploy).
#    --target is optional; without it, uses the default target (set in step 1).
# ─────────────────────────────────────────────────────────────────────────────
$UXC mp install contract-management --target inst          # latest version
$UXC mp install contract-management@1.0.1 --target inst    # a specific version
# manual equivalent (explicit hash gate):
$UXC mp pull contract-management -o ct.uxpkg               # download + sha256 check
$UXC import ct.uxpkg --target inst --expect-sha256 "<sha256-from-mp-show>"

# ─────────────────────────────────────────────────────────────────────────────
# 5. Publish a package you built (run from inside a package dir w/ uxopian-project.json).
# ─────────────────────────────────────────────────────────────────────────────
cd /path/to/your-package
$UXC mp init                    # scaffold marketplace.json (slug, audience, category, compatibility, assets)
#   …edit marketplace.json: compatibility = the versions you TESTED on; add screenshots/docs paths…
$UXC mp publish --dry-run       # export + build object catalog + validate, NO network — read it back
$UXC mp publish                 # upsert listing → upload .uxpkg + assets → finalize
#   bump "version" in uxopian-project.json for a content change; same version + same hash edits in place.

# ─────────────────────────────────────────────────────────────────────────────
# 6. Version lifecycle.
# ─────────────────────────────────────────────────────────────────────────────
$UXC mp deprecate contract-management --version 1.0.0                    # mark deprecated (still downloadable)
$UXC mp deprecate contract-management --version 1.0.0 --yank             # hide (kept for audit)
$UXC mp deprecate contract-management --version 1.0.0 --reactivate       # restore

# ─────────────────────────────────────────────────────────────────────────────
# One-off WITHOUT registering a target — pass url+scope via env (overrides per field).
# Works for any command that deploys/reads an instance (import, mp install, run, …).
# ─────────────────────────────────────────────────────────────────────────────
UXC_URL="$URL" UXC_SCOPE="$SCOPE" UXC_USER="$USER" UXC_PASSWORD="$PASSWORD" \
  $UXC mp install contract-management
