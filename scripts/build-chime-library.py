#!/usr/bin/env python3
"""Build src/chimeLibrary.ts from a directory of chime MP3s.

Usage: build-chime-library.py <mp3_dir> <out_ts>

Invoked by scripts/gen-chimes.sh after it synthesizes the MP3s. Emits each
chime as a base64 string wrapped into 100-char chunks (mirrors chimeAudio.ts).
"""
import base64
import os
import sys

# Display order; blip must be first (it is the default).
NAMES = ["blip", "two-tone", "rising", "falling", "bell",
         "marimba", "glass", "pop", "chord", "pulse"]

DESC = {
    "blip": "soft rising glide 540->680 Hz (legacy default)",
    "two-tone": "two gentle pips, 660 then 880 Hz",
    "rising": "smooth upward sweep 440->880 Hz",
    "falling": "smooth downward sweep 880->440 Hz",
    "bell": "soft bell: fundamental + octave partial, exp decay",
    "marimba": "woody pluck around 587 Hz, fast decay",
    "glass": "high glassy ping around 1175 Hz",
    "pop": "very short soft pop around 420 Hz",
    "chord": "soft two-note chord (C5 + E5)",
    "pulse": "gentle double-pulse at 700 Hz",
}

HEADER = '''// AUTO-GENERATED soft chime library. Do not edit by hand; regenerate with
// scripts/gen-chimes.sh (requires ffmpeg + libmp3lame).
//
// Each value is a short (~0.2-0.4s), low-gain MP3 chime, base64-encoded and
// inlined so samograph ships no binary asset files. These are played into the
// call's audio track via Recall's output_audio endpoint when the bot posts a
// meeting-chat message -- the AUDIBLE path participants hear. The camera-page
// WebAudio cue in presence.ts is a separate, video-only nicety.
//
// Generated offline with ffmpeg (libmp3lame, mono, 44.1 kHz, 48 kbps) from
// synthesized sine tones / sweeps.
//
// Sounds (all soft, non-annoying):
'''


def main() -> None:
    mp3_dir, out_ts = sys.argv[1], sys.argv[2]
    out = [HEADER]
    for n in NAMES:
        out.append(f"//   {n}{' ' * (9 - len(n))}{DESC[n]}\n")
    out.append("\n")
    out.append('export const DEFAULT_CHIME = "blip";\n\n')
    out.append("// name -> base64-encoded MP3 (mono). DEFAULT_CHIME must be a key here.\n")
    out.append("export const CHIME_LIBRARY: Record<string, string> = {\n")
    for n in NAMES:
        with open(os.path.join(mp3_dir, n + ".mp3"), "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        chunks = [b64[i:i + 100] for i in range(0, len(b64), 100)]
        out.append(f'  "{n}":\n')
        for idx, c in enumerate(chunks):
            suffix = " +" if idx < len(chunks) - 1 else ","
            out.append(f'    "{c}"{suffix}\n')
    out.append("};\n")
    with open(out_ts, "w") as f:
        f.write("".join(out))


if __name__ == "__main__":
    main()
