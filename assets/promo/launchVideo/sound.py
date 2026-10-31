#!/usr/bin/env python3
"""Original sound design for the launch film, synthesised with NumPy.

A tight 120 BPM pulse, whooshes, UI clicks and one clean final hit. No
samples, no music. Every cue is placed on the storyboard's timing grid.

  python3 sound.py --out sound.wav [--target-lufs -16]
"""
from __future__ import annotations

import argparse
import math
import pathlib
import re
import subprocess
import wave

import numpy as np

SR = 48000
DUR = 25.0
N = int(SR * DUR)
L = np.zeros(N)
R = np.zeros(N)
rng = np.random.default_rng(7)


def t_axis(n: int) -> np.ndarray:
    return np.arange(n) / SR


def add(sig: np.ndarray, t0: float, pan: float | np.ndarray = 0.0, gain: float = 1.0) -> None:
    """Mix `sig` in at `t0` seconds. pan −1..1 (constant power); may be per-sample."""
    i0 = int(round(t0 * SR))
    if i0 >= N:
        return
    sig = sig[: N - i0]
    n = len(sig)
    pan = np.broadcast_to(np.asarray(pan, dtype=float), (n,)) if np.ndim(pan) else np.full(n, float(pan))
    a = (pan + 1) * math.pi / 4
    L[i0 : i0 + n] += sig * gain * np.cos(a)
    R[i0 : i0 + n] += sig * gain * np.sin(a)


def noise(n: int) -> np.ndarray:
    return rng.standard_normal(n)


def svf_bandpass(x: np.ndarray, fc, q: float = 0.7) -> np.ndarray:
    """Chamberlin state-variable band-pass with a per-sample cutoff."""
    fc = np.broadcast_to(np.asarray(fc, dtype=float), x.shape)
    f = 2 * np.sin(np.pi * np.minimum(fc, SR / 6.5) / SR)
    out = np.empty_like(x)
    lp = bp = 0.0
    for i in range(len(x)):
        hp = x[i] - lp - q * bp
        bp += f[i] * hp
        lp += f[i] * bp
        out[i] = bp
    return out


def env_ad(n: int, attack: float, release: float) -> np.ndarray:
    t = t_axis(n)
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    r = np.exp(-np.maximum(0, t - attack) / max(release, 1e-4))
    return a * r


def kick(f0=110.0, f1=48.0, sweep=0.03, tau=0.05, dur=0.4, amp=1.0, click=0.5) -> np.ndarray:
    n = int(dur * SR)
    t = t_axis(n)
    f = f1 + (f0 - f1) * np.exp(-t / sweep)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * np.exp(-t / tau)
    s = np.tanh(1.8 * s) / math.tanh(1.8)
    c = noise(n) * np.exp(-t / 0.0035) * click
    return (s + c) * amp


def ping(freq: float, dur=0.12, tau=0.03, amp=0.2, attack=0.001) -> np.ndarray:
    n = int(dur * SR)
    t = t_axis(n)
    s = np.sin(2 * np.pi * freq * t) * np.exp(-t / tau) * np.clip(t / attack, 0, 1)
    return s * amp


def click(amp=0.25, freq=2600.0, length=0.004) -> np.ndarray:
    n = int(0.08 * SR)
    t = t_axis(n)
    burst = noise(n) * (t < length) * np.exp(-t / (length / 2))
    burst = svf_bandpass(burst, 3200.0, 0.9) * 3
    return (burst + ping(freq, 0.08, 0.012, 0.7)[:n]) * amp


def whoosh(dur: float, f_from: float, f_to: float, amp=0.3, attack=0.35, q=0.6) -> np.ndarray:
    """Band-passed noise whose centre frequency sweeps f_from → f_to."""
    n = int(dur * SR)
    t = t_axis(n) / dur
    fc = np.exp(np.log(f_from) + (np.log(f_to) - np.log(f_from)) * t)
    s = svf_bandpass(noise(n), fc, q)
    s /= np.max(np.abs(s)) + 1e-9
    env = np.sin(np.pi * np.clip(t, 0, 1)) ** (1.0 if attack == 0.5 else (0.6 if attack < 0.5 else 1.6))
    if attack < 0.5:  # fast rise, long fall
        env = np.where(t < attack, (t / attack) ** 0.8, (1 - (t - attack) / (1 - attack)) ** 1.4)
    elif attack > 0.5:  # long rise, fast fall
        env = np.where(t < attack, (t / attack) ** 1.6, (1 - (t - attack) / (1 - attack)) ** 0.8)
    return s * env * amp


def impact(amp=0.5) -> np.ndarray:
    n = int(0.25 * SR)
    t = t_axis(n)
    s = svf_bandpass(noise(n), 1400.0 * np.exp(-t * 6) + 300, 0.5)
    s /= np.max(np.abs(s)) + 1e-9
    return s * np.exp(-t / 0.045) * amp


def reverb(sig: np.ndarray, tail=1.6, tau=0.38, mix=0.35) -> np.ndarray:
    n = int(tail * SR)
    ir = noise(n) * np.exp(-t_axis(n) / tau)
    ir = svf_bandpass(ir, 2200.0, 0.9)
    ir /= np.sqrt(np.sum(ir**2)) + 1e-9
    m = len(sig) + n - 1
    out = np.fft.irfft(np.fft.rfft(sig, m) * np.fft.rfft(ir, m), m)
    dry = np.zeros(m)
    dry[: len(sig)] = sig
    return dry + out * mix * 4


# ---------------------------------------------------------------- cue sheet
CUTS = [2.5, 5.5, 8.5, 12.0, 14.5, 17.0, 19.5, 22.5]

# pulse: 120 BPM, beat 1 at 0.50, stops before the cut to white
b = 0.5
while b <= 22.0 + 1e-6:
    accent = any(abs(b - c) < 1e-6 for c in CUTS)
    add(kick(amp=0.78 if accent else 0.42, tau=0.06 if accent else 0.045, click=0.7 if accent else 0.4), b)
    if accent:
        add(impact(0.32), b)
        add(whoosh(0.32, 2600, 500, 0.16, attack=0.1), b + 0.005)
    b = round(b + 0.5, 6)
add(impact(0.32), 22.5)
add(whoosh(0.32, 2600, 500, 0.16, attack=0.1), 22.505)
add(kick(amp=0.78, tau=0.06, click=0.7), 22.5)

# S01 keystrokes, send click, push-in whoosh
for i in range(27):
    add(click(0.11, rng.uniform(1800, 3200), 0.003), 0.2 + i * 0.04, pan=rng.uniform(-0.2, 0.2))
add(click(0.3), 2.0)
add(whoosh(0.42, 300, 3800, 0.42, attack=0.85), 2.08)

# S02 zoom-out whoosh, node pops, edge shimmer
add(whoosh(0.6, 3200, 260, 0.3, attack=0.12), 2.5)
PENTA = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.7, 1318.5]
for i, t0 in enumerate([2.5, 2.8, 2.92, 3.04, 3.16, 3.28, 3.40, 3.52]):
    add(ping(PENTA[i], 0.2, 0.05, 0.16, 0.004), t0, pan=rng.uniform(-0.5, 0.5))
n_sh = int(1.2 * SR)
shimmer = svf_bandpass(noise(n_sh), np.linspace(5000, 8500, n_sh), 0.5)
shimmer /= np.max(np.abs(shimmer)) + 1e-9
add(shimmer * np.sin(np.pi * np.linspace(0, 1, n_sh)) ** 1.5 * 0.055, 3.3)

# S03 select click, marquee hiss, count tick
add(click(0.3), 5.8)
n_h = int(0.62 * SR)
hiss = svf_bandpass(noise(n_h), np.linspace(1100, 2600, n_h), 0.5)
hiss /= np.max(np.abs(hiss)) + 1e-9
add(hiss * env_ad(n_h, 0.1, 0.35) * 0.09, 6.7)
add(click(0.22, 2200), 7.25)

# S04 whip pan (left → right), brush swishes, bloom, shutter clicks on the beat
add(whoosh(0.32, 500, 4200, 0.5, attack=0.4), 8.49, pan=np.linspace(-0.9, 0.9, int(0.32 * SR)))
for t0 in (8.80, 8.98, 9.16):
    add(whoosh(0.2, 900, 2300, 0.1, attack=0.3), t0, pan=np.linspace(-0.3, 0.5, int(0.2 * SR)))
bloom = ping(783.99, 0.5, 0.14, 0.09, 0.02) + ping(1174.7, 0.5, 0.12, 0.06, 0.02)
add(bloom, 9.45)
for t0 in (10.0, 10.5, 11.0, 11.5):
    add(click(0.34, 2900, 0.005), t0)
    add(click(0.18, 1900, 0.003), t0 + 0.04)

# S05 car pass-by (right → left), two wipe swishes
n_car = int(1.9 * SR)
tc = np.linspace(0, 1, n_car)
car = svf_bandpass(noise(n_car), 190 * np.exp(-0.9 * tc) + 60, 0.55)
car /= np.max(np.abs(car)) + 1e-9
hum_f = 95 * np.exp(-0.7 * tc) + 20
hum = np.sin(2 * np.pi * np.cumsum(hum_f) / SR)
car_env = np.sin(np.pi * tc) ** 1.3
add((car * 0.7 + hum * 0.5) * car_env * 0.24, 12.15, pan=np.linspace(0.85, -0.85, n_car))
for t0 in (13.5, 14.0):
    add(whoosh(0.36, 1800, 6500, 0.17, attack=0.3), t0, pan=np.linspace(-0.8, 0.8, int(0.36 * SR)))

# S06 boundary ticks, lock click, depth swoosh
for t0 in (14.58, 14.70, 14.82):
    add(click(0.2, 2400), t0)
add(click(0.26, 1700), 15.0)
add(whoosh(0.45, 2600, 900, 0.16, attack=0.3), 16.2)

# S07 confirm click, candidate pops
add(click(0.3), 18.3)
for i, t0 in enumerate((18.45, 18.6, 18.75)):
    add(ping(PENTA[3 + i], 0.22, 0.06, 0.17, 0.004), t0, pan=-0.4 + 0.4 * i)

# S08 push whoosh, check ticks (one thud), flip click, replace, audio slide, playhead sweep, export click
add(whoosh(0.28, 400, 3200, 0.3, attack=0.75), 19.23)
for i in range(6):
    t0 = 19.6 + i * 0.12
    if i == 4:
        add(kick(180, 90, 0.015, 0.04, 0.25, 0.4, click=0.3), t0)
    else:
        add(ping(2200 + 60 * i, 0.1, 0.02, 0.16, 0.001), t0)
add(click(0.3, 2000), 20.5)
add(whoosh(0.3, 2400, 700, 0.2, attack=0.2), 20.7)
add(whoosh(0.24, 700, 2600, 0.16, attack=0.6), 20.8)
add(whoosh(0.22, 600, 2200, 0.14, attack=0.6), 21.4, pan=np.linspace(-0.8, 0.0, int(0.22 * SR)))
add(whoosh(0.56, 350, 4500, 0.45, attack=0.9), 21.9, pan=np.linspace(-0.9, 0.9, int(0.56 * SR)))
add(click(0.34), 22.45)

# S09 two soft taps for lines two and three, one clean final hit
for t0 in (22.7, 22.9):
    add(kick(90, 45, 0.02, 0.05, 0.3, 0.34, click=0.15), t0)
hit = kick(72, 44, 0.08, 0.42, 1.8, 0.95, click=0.9)
add(hit, 23.2)
add(reverb(impact(0.55), tail=1.5, tau=0.36, mix=0.4), 23.2)


# ---------------------------------------------------------------- master
def limiter(stereo: np.ndarray, ceiling=0.89, lookahead=0.005, release=0.12) -> np.ndarray:
    """Look-ahead peak limiter: instant attack, exponential release."""
    peak = np.max(np.abs(stereo), axis=1)
    la = int(lookahead * SR)
    m = peak.copy()
    step = 1
    while step < la:
        m[:-step] = np.maximum(m[:-step], m[step:])
        step *= 2
    g = np.minimum(1.0, ceiling / np.maximum(m, 1e-9))
    out = np.empty_like(g)
    cur = 1.0
    k = 1 - math.exp(-1 / (release * SR))
    for i in range(len(g)):
        cur = g[i] if g[i] < cur else cur + (g[i] - cur) * k
        out[i] = cur
    box = int(0.001 * SR)
    out = np.convolve(out, np.ones(box) / box, mode="same")
    return stereo * np.minimum(out, g)[:, None]


def write_wav(path: pathlib.Path, gain: float) -> None:
    mix = limiter(np.stack([L, R], axis=1) * gain)
    mix = np.tanh(mix * 1.02) / math.tanh(1.02)  # safety
    pcm = np.clip(mix * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def measure_lufs(path: pathlib.Path) -> float | None:
    try:
        res = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=framelog=quiet", "-f", "null", "-"], capture_output=True, text=True)
    except FileNotFoundError:
        return None
    m = re.findall(r"I:\s*(-?[\d.]+) LUFS", res.stderr)
    return float(m[-1]) if m else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(pathlib.Path(__file__).with_name("sound.wav")))
    ap.add_argument("--target-lufs", type=float, default=-16.0)
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    peak = max(np.max(np.abs(L)), np.max(np.abs(R)))
    gain = 0.89 / peak  # −1 dBFS peak first
    write_wav(out, gain)
    lufs = measure_lufs(out)
    for _ in range(3):  # converge on the target; the limiter eats part of each gain step
        if lufs is None or abs(lufs - args.target_lufs) < 0.2:
            break
        gain *= 10 ** ((args.target_lufs - lufs) / 20)
        write_wav(out, gain)  # the limiter holds the ceiling at −1 dBFS
        lufs = measure_lufs(out)
    print(f"wrote {out}  peak gain {gain:.3f}  integrated loudness {lufs} LUFS")


if __name__ == "__main__":
    main()
