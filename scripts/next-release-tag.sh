#!/usr/bin/env bash
#
# Compute the next samohost production deploy tag.
#
# Usage:  git tag --list 'v*' | scripts/next-release-tag.sh <YYYYMMDD>
#
# Reads candidate tags on stdin (one per line), keeps only those matching
# samohost's deploy grammar (NikolayS/samohost src/commands/app.ts:1212)
#
#     ^v(\d{4})(\d{2})(\d{2})\.([1-9]\d*)$        e.g. v20260904.1
#
# and prints `v<date>.<N>` on stdout, where N is **max(N for that date) + 1**
# (1 when the date has no tags yet).
#
# NB: max+1, deliberately NOT "first free N" — deleting v20260904.5 out of
# .1 … .12 must not make us reuse .5, which is older than .12 and would be
# rejected by samohost's strictly-newer rule (and would reuse a tag name).
#
# Exits non-zero if the computed tag is not strictly newer than the newest
# existing deploy tag (clock skew, or a future-dated tag already in the repo).
set -euo pipefail

today="${1:-}"
if ! printf '%s' "$today" | grep -Eq '^[0-9]{8}$'; then
  echo "usage: $0 <YYYYMMDD>   (tags on stdin)" >&2
  exit 2
fi

# Ordering key: (YYYYMMDD, zero-padded N) as one comparable integer string.
key() { printf '%s%09d\n' "${1:1:8}" "${1##*.}"; }

tags="$(grep -E '^v[0-9]{8}\.[1-9][0-9]*$' || true)"

# Highest N already used for `today`.
max_n=0
if [ -n "$tags" ]; then
  max_n="$(printf '%s\n' "$tags" \
    | grep -E "^v${today}\." \
    | sed 's/.*\.//' \
    | sort -n | tail -n 1 || true)"
  [ -n "$max_n" ] || max_n=0
fi
tag="v${today}.$((max_n + 1))"

# Newest existing deploy tag overall, by (date, N).
last=""
if [ -n "$tags" ]; then
  last="$(printf '%s\n' "$tags" \
    | while read -r t; do echo "$(key "$t") $t"; done \
    | sort | tail -n 1 | cut -d' ' -f2 || true)"
fi

if [ -n "$last" ]; then
  echo "last deploy tag: $last" >&2
  if [ "$(key "$tag")" -le "$(key "$last")" ]; then
    echo "computed tag ${tag} is not strictly newer than ${last} (clock skew or a future-dated tag)" >&2
    exit 1
  fi
else
  echo "no existing deploy tags — this is the first one" >&2
fi

printf '%s\n' "$tag"
