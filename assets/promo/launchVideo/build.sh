#!/usr/bin/env bash
# Build the OpenCinema launch film: soundtrack → frames → encode → mux → checks.
#
#   bash assets/promo/launchVideo/build.sh            # full quality (≈ 16 min)
#   SAMPLES=1 bash assets/promo/launchVideo/build.sh  # quick preview without motion blur
#
# Needs: node 22 with Playwright + Chromium, ffmpeg with libx264 and aac,
# python3 with numpy, and the Inter / Inter Display / JetBrains Mono fonts installed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${OUT:-$here/../openCinemaLaunch.mp4}"
work="${WORK:-$(mktemp -d)}"
samples="${SAMPLES:-4}"

echo "» soundtrack"
python3 "$here/sound.py" --out "$work/sound.wav"

echo "» frames + H.264 (samples/frame: $samples)"
node "$here/render.mjs" --out "$work/film.video.mp4" --samples "$samples" --crf 16

echo "» mux"
ffmpeg -y -hide_banner -loglevel error -i "$work/film.video.mp4" -i "$work/sound.wav" \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 -t 30 -movflags +faststart "$out"

echo "» checks"
ffprobe -v error -show_entries stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,nb_frames,sample_rate,channels:format=duration,size -of default=nw=1 "$out"
echo "written: $out"
