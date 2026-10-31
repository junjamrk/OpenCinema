#!/usr/bin/env python3
"""Original sound design for the launch film, synthesised with NumPy.

A tight 150 BPM pulse, whooshes, UI clicks and one clean final hit. No
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
DUR = 15.0
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
CUTS = [1.6, 3.6, 5.2, 6.8, 8.4, 9.6, 10.8, 12.4]

# pulse: 150 BPM, beat 1 at 0.40, stops at the cut to white
b = 0.4
while b <= 12.0 + 1e-6:
    accent = any(abs(b - c) < 1e-6 for c in CUTS)
    add(kick(amp=0.78 if accent else 0.42, tau=0.06 if accent else 0.045, click=0.7 if accent else 0.4), b)
    if accent:
        add(impact(0.32), b)
        add(whoosh(0.32, 2600, 500, 0.16, attack=0.1), b + 0.005)
    b = round(b + 0.4, 6)

# S01 keystrokes, send click, push-in whoosh
for i in range(27):
    add(click(0.11, rng.uniform(1800, 3200), 0.003), 0.15 + i * 0.033, pan=rng.uniform(-0.2, 0.2))
add(click(0.3), 1.2)
add(whoosh(0.34, 300, 3800, 0.42, attack=0.85), 1.27)

# S02 zoom-out whoosh, node pops, edge shimmer
add(whoosh(0.55, 3200, 260, 0.3, attack=0.12), 1.6)
PENTA = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.7, 1318.5]
for i, t0 in enumerate([1.6, 1.85, 1.95, 2.05, 2.15, 2.25, 2.35, 2.45]):
    add(ping(PENTA[i], 0.2, 0.05, 0.16, 0.004), t0, pan=rng.uniform(-0.5, 0.5))
shimmer = svf_bandpass(noise(int(0.8 * SR)), np.linspace(5000, 8500, int(0.8 * SR)), 0.5)
shimmer /= np.max(np.abs(shimmer)) + 1e-9
add(shimmer * np.sin(np.pi * np.linspace(0, 1, len(shimmer))) ** 1.5 * 0.055, 2.25)

# S03 select click, marquee hiss, count tick
add(click(0.3), 3.8)
hiss = svf_bandpass(noise(int(0.42 * SR)), np.linspace(1100, 2600, int(0.42 * SR)), 0.5)
hiss /= np.max(np.abs(hiss)) + 1e-9
add(hiss * env_ad(len(hiss), 0.08, 0.25) * 0.09, 4.2)
add(click(0.22, 2200), 4.6)

# S04 whip pan (left → right), brush swishes, bloom, shutter clicks
add(whoosh(0.3, 500, 4200, 0.5, attack=0.4), 5.19, pan=np.linspace(-0.9, 0.9, int(0.3 * SR)))
for t0 in (5.40, 5.53, 5.66):
    add(whoosh(0.17, 900, 2300, 0.1, attack=0.3), t0, pan=np.linspace(-0.3, 0.5, int(0.17 * SR)))
bloom = ping(783.99, 0.5, 0.14, 0.09, 0.02) + ping(1174.7, 0.5, 0.12, 0.06, 0.02)
add(bloom, 5.85)
for t0 in (6.0, 6.2, 6.4, 6.6):
    add(click(0.34, 2900, 0.005), t0)
    add(click(0.18, 1900, 0.003), t0 + 0.04)

# S05 car pass-by (right → left), two wipe swishes
n_car = int(1.2 * SR)
tc = np.linspace(0, 1, n_car)
car = svf_bandpass(noise(n_car), 190 * np.exp(-0.9 * tc) + 60, 0.55)
car /= np.max(np.abs(car)) + 1e-9
hum_f = 95 * np.exp(-0.7 * tc) + 20
hum = np.sin(2 * np.pi * np.cumsum(hum_f) / SR)
car_env = np.sin(np.pi * tc) ** 1.3
add((car * 0.7 + hum * 0.5) * car_env * 0.24, 6.9, pan=np.linspace(0.85, -0.85, n_car))
for t0 in (7.6, 8.0):
    add(whoosh(0.3, 1800, 6500, 0.17, attack=0.3), t0, pan=np.linspace(-0.8, 0.8, int(0.3 * SR)))

# S06 boundary ticks, lock click, depth swoosh
for t0 in (8.50, 8.56, 8.62):
    add(click(0.2, 2400), t0)
add(click(0.26, 1700), 8.75)
add(whoosh(0.36, 2600, 900, 0.16, attack=0.3), 9.1)

# S07 confirm click, candidate pops
add(click(0.3), 10.0)
for i, t0 in enumerate((10.1, 10.2, 10.3)):
    add(ping(PENTA[3 + i], 0.22, 0.06, 0.17, 0.004), t0, pan=-0.4 + 0.4 * i)

# S08 push whoosh, check ticks (one thud), flip click, replace, audio slide, playhead sweep, export click
add(whoosh(0.26, 400, 3200, 0.3, attack=0.75), 10.78)
for i in range(6):
    t0 = 10.95 + i * 0.08
    if i == 4:
        add(kick(180, 90, 0.015, 0.04, 0.25, 0.4, click=0.3), t0)
    else:
        add(ping(2200 + 60 * i, 0.1, 0.02, 0.16, 0.001), t0)
add(click(0.3, 2000), 11.4)
add(whoosh(0.3, 2400, 700, 0.2, attack=0.2), 11.5)
add(whoosh(0.22, 700, 2600, 0.16, attack=0.6), 11.58)
add(whoosh(0.2, 600, 2200, 0.14, attack=0.6), 11.9, pan=np.linspace(-0.8, 0.0, int(0.2 * SR)))
add(whoosh(0.32, 350, 4500, 0.45, attack=0.9), 12.1, pan=np.linspace(-0.9, 0.9, int(0.32 * SR)))
add(click(0.34), 12.4)

# S09 three soft taps for the three lines, one clean final hit
for t0 in (12.6, 12.8):
    add(kick(90, 45, 0.02, 0.05, 0.3, 0.34, click=0.15), t0)
hit = kick(72, 44, 0.08, 0.42, 1.8, 0.95, click=0.9)
add(hit, 13.2)
add(reverb(impact(0.55), tail=1.5, tau=0.36, mix=0.4), 13.2)


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
