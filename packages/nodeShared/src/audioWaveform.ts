export function getWaveformPeaks(channels: readonly Float32Array[], barCount = 128): number[] {
  if (!Number.isInteger(barCount) || barCount <= 0) throw new RangeError("波形条数必须为正整数");
  const peaks = Array<number>(barCount).fill(0);
  const sampleCount = channels.reduce((length, channel) => Math.max(length, channel.length), 0);
  let maximum = 0;
  for (let bar = 0; bar < barCount && sampleCount > 0; bar++) {
    const start = Math.floor(bar * sampleCount / barCount);
    // ACT: 极短音频复用当前样本填满显示条数，不插值或合并声道，避免反相抵消。
    const end = Math.max(start + 1, Math.floor((bar + 1) * sampleCount / barCount));
    for (const channel of channels) {
      for (let sample = start; sample < Math.min(end, channel.length); sample++) {
        const amplitude = Math.abs(channel[sample]!);
        if (Number.isFinite(amplitude)) peaks[bar] = Math.max(peaks[bar]!, amplitude);
      }
    }
    maximum = Math.max(maximum, peaks[bar]!);
  }
  return maximum > 0 ? peaks.map(peak => peak / maximum) : peaks;
}
