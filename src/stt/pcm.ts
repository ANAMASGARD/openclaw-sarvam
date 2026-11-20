export type AudioInput = { encoding: "mulaw" | "pcm16le"; sampleRate: number; channels: number };

export function decodeMulaw(value: number): number {
  const sample = ~value & 255;
  const magnitude = (((sample & 15) << 3) + 132) << ((sample >> 4) & 7);
  return sample & 128 ? 132 - magnitude : magnitude - 132;
}

export function pcmConverter(input: AudioInput, outputRate: number) {
  const sampleBytes = input.encoding === "mulaw" ? 1 : 2;
  const stride = sampleBytes * input.channels;
  let tail = Buffer.alloc(0);
  let phase = 0;
  let sum = 0;
  let count = 0;
  return (inputBytes: Buffer): Buffer => {
    const buffer = tail.length ? Buffer.concat([tail, inputBytes]) : inputBytes;
    const samples = Math.floor(buffer.length / stride);
    const output = Buffer.allocUnsafe((Math.ceil((samples * outputRate) / input.sampleRate) + 1) * 2);
    let offset = 0;
    for (let frame = 0; frame < samples; frame++) {
      let mono = 0;
      for (let channel = 0; channel < input.channels; channel++) {
        const index = frame * stride + channel * sampleBytes;
        mono += sampleBytes === 1 ? decodeMulaw(buffer[index]!) : buffer.readInt16LE(index);
      }
      const sample = mono / input.channels;
      sum += sample;
      count++;
      phase += outputRate;
      while (phase >= input.sampleRate) {
        output.writeInt16LE(Math.round(count ? sum / count : sample), offset);
        offset += 2;
        phase -= input.sampleRate;
        sum = 0;
        count = 0;
      }
    }
    tail = Buffer.from(buffer.subarray(samples * stride));
    return output.subarray(0, offset);
  };
}
