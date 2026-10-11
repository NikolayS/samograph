#!/usr/bin/env bash
#
# Regenerate the soft chime sound library: src/chimeLibrary.ts.
#
# Synthesizes 10 short, soft, low-gain chime MP3s with ffmpeg (libmp3lame),
# base64-encodes them, and writes src/chimeLibrary.ts. The MP3s are inlined so
# samograph ships no binary asset files.
#
# Requires: ffmpeg with libmp3lame, python3.
# Usage:    bash scripts/gen-chimes.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_TS="$ROOT/src/chimeLibrary.ts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg not found on PATH" >&2
  exit 1
fi
if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libmp3lame; then
  echo "error: ffmpeg is missing the libmp3lame MP3 encoder" >&2
  exit 1
fi

LAME=(-c:a libmp3lame -b:a 48k -ac 1 -ar 44100)

gen() {
  local name="$1" expr="$2" dur="$3" af="$4"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "aevalsrc=exprs=${expr}:sample_rate=44100:duration=${dur}" \
    -af "$af" "${LAME[@]}" "$WORK/${name}.mp3"
}

# 1. blip — soft rising glide 540->680, the legacy default sound
gen blip "0.22*sin(2*PI*(540+140*t/0.06)*t)" 0.30 \
  "lowpass=f=1800,afade=t=in:st=0:d=0.012,afade=t=out:st=0.06:d=0.24"
# 2. two-tone — two gentle pips 660 then 880
gen two-tone "0.22*sin(2*PI*660*t)*lt(t\,0.12)+0.22*sin(2*PI*880*t)*between(t\,0.14\,0.30)" 0.32 \
  "lowpass=f=2200,afade=t=out:st=0.28:d=0.04"
# 3. rising — smooth upward sweep 440->880
gen rising "0.20*sin(2*PI*(440+440*t/0.28)*t)" 0.30 \
  "lowpass=f=2400,afade=t=in:st=0:d=0.02,afade=t=out:st=0.22:d=0.08"
# 4. falling — smooth downward sweep 880->440
gen falling "0.20*sin(2*PI*(880-440*t/0.28)*t)" 0.30 \
  "lowpass=f=2400,afade=t=in:st=0:d=0.02,afade=t=out:st=0.22:d=0.08"
# 5. bell — soft bell: fundamental + octave partial, exponential decay
gen bell "(0.18*sin(2*PI*784*t)+0.07*sin(2*PI*1568*t))*exp(-7*t)" 0.40 \
  "lowpass=f=4000,afade=t=in:st=0:d=0.005"
# 6. marimba — woody pluck: fundamental + weak 4th partial, fast decay
gen marimba "(0.20*sin(2*PI*587*t)+0.05*sin(2*PI*2348*t))*exp(-13*t)" 0.30 \
  "lowpass=f=3000,afade=t=in:st=0:d=0.004"
# 7. glass — high glassy ping ~1175 Hz, quick shimmer decay
gen glass "(0.16*sin(2*PI*1175*t)+0.05*sin(2*PI*1760*t))*exp(-9*t)" 0.34 \
  "lowpass=f=5000,afade=t=in:st=0:d=0.004"
# 8. pop — very short soft pop around 420 Hz
gen pop "0.22*sin(2*PI*420*t)*exp(-20*t)" 0.20 \
  "lowpass=f=1600,afade=t=in:st=0:d=0.004"
# 9. chord — soft two-note chord (C5 + E5) ringing together
gen chord "(0.13*sin(2*PI*523*t)+0.13*sin(2*PI*659*t))*exp(-6*t)" 0.40 \
  "lowpass=f=3200,afade=t=in:st=0:d=0.006"
# 10. pulse — gentle double-pulse at 700 Hz
gen pulse "0.20*sin(2*PI*700*t)*(between(t\,0\,0.09)+between(t\,0.14\,0.23))" 0.26 \
  "lowpass=f=2000,afade=t=out:st=0.22:d=0.04"

python3 "$ROOT/scripts/build-chime-library.py" "$WORK" "$OUT_TS"
echo "wrote $OUT_TS"
