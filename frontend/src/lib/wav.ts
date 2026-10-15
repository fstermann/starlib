/** A 32-bit float WAV of interleaved `channels`, so summed stems never clip. */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const frames = channels[0]?.length ?? 0;
  const blockAlign = channels.length * 4;
  const dataBytes = frames * blockAlign;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++)
      view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels.length; c++)
      view.setFloat32(44 + i * blockAlign + c * 4, channels[c][i], true);
  return new Uint8Array(view.buffer);
}
