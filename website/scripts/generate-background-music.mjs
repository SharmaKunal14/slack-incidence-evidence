import { writeFileSync } from "node:fs";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BPM = 112;
const DEFAULT_DURATION_SECONDS = 90;

const outputPath = process.argv[2];
const durationSeconds = Number(process.argv[3] ?? DEFAULT_DURATION_SECONDS);

if (!outputPath) {
  throw new Error(
    "Usage: node scripts/generate-background-music.mjs <output.wav> [duration-seconds]",
  );
}

if (
  !Number.isFinite(durationSeconds) ||
  durationSeconds <= 0 ||
  durationSeconds > 600
) {
  throw new Error("Duration must be between 0 and 600 seconds.");
}

const secondsPerBeat = 60 / BPM;
const frameCount = Math.floor(durationSeconds * SAMPLE_RATE);
const bytesPerSample = BITS_PER_SAMPLE / 8;
const dataSize = frameCount * CHANNELS * bytesPerSample;
const wav = Buffer.allocUnsafe(44 + dataSize);

const progression = [
  [62, 66, 69, 73, 76], // Dmaj9
  [59, 62, 66, 69, 73], // Bm9
  [55, 59, 62, 66, 69], // Gmaj9
  [57, 61, 64, 69, 71], // Aadd9
];
const bassNotes = [38, 35, 31, 33];
const melody = [74, 76, 78, 81, 78, 76, 73, 74];

function midiToFrequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(edge0, edge1, value) {
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function deterministicNoise(sampleIndex, salt) {
  let value = (sampleIndex + salt) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value / 0x7fffffff) * 2 - 1;
}

function oscillator(frequency, time, harmonic = 0) {
  const phase = 2 * Math.PI * frequency * time;
  return (
    Math.sin(phase) +
    0.24 * Math.sin(phase * 2 + harmonic) +
    0.08 * Math.sin(phase * 3 + harmonic * 0.5)
  );
}

function writeWavHeader(buffer) {
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(
    SAMPLE_RATE * CHANNELS * bytesPerSample,
    28,
  );
  buffer.writeUInt16LE(CHANNELS * bytesPerSample, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
}

writeWavHeader(wav);

for (let frame = 0; frame < frameCount; frame += 1) {
  const time = frame / SAMPLE_RATE;
  const beat = time / secondsPerBeat;
  const beatIndex = Math.floor(beat);
  const beatFraction = beat - beatIndex;
  const bar = Math.floor(beat / 4);
  const beatInBar = beat - bar * 4;
  const chord = progression[bar % progression.length];
  const barTime = beatInBar * secondsPerBeat;
  const barDuration = secondsPerBeat * 4;

  const barEnvelope =
    smoothstep(0, 0.24, barTime) *
    (1 - smoothstep(barDuration - 0.3, barDuration, barTime));
  const sidechain = 0.62 + 0.38 * smoothstep(0.05, 0.42, beatFraction);

  let padLeft = 0;
  let padRight = 0;
  for (let voice = 0; voice < chord.length; voice += 1) {
    const frequency = midiToFrequency(chord[voice]);
    const detune = voice % 2 === 0 ? 0.9985 : 1.0015;
    const tone = oscillator(frequency * detune, time, voice * 0.37);
    const pan = voice / (chord.length - 1);
    padLeft += tone * (1 - pan * 0.42);
    padRight += tone * (0.58 + pan * 0.42);
  }
  const padGain = 0.044 * barEnvelope * sidechain;
  padLeft *= padGain;
  padRight *= padGain;

  const eighthNote = Math.floor(beat * 2);
  const eighthTime =
    (beat * 2 - eighthNote) * (secondsPerBeat / 2);
  const arpNote = chord[[0, 2, 4, 2, 1, 3, 4, 3][eighthNote % 8]];
  const arpFrequency = midiToFrequency(arpNote + 12);
  const arpEnvelope = Math.exp(-eighthTime * 8.5);
  const arp =
    oscillator(arpFrequency, time, 0.8) *
    arpEnvelope *
    (time < 8 ? 0.032 : 0.045);
  const arpPan = 0.5 + 0.36 * Math.sin(eighthNote * 1.7);

  const bassFrequency = midiToFrequency(bassNotes[bar % bassNotes.length]);
  const bassEnvelope = Math.exp(-beatFraction * 2.8);
  const bass =
    (Math.sin(2 * Math.PI * bassFrequency * time) +
      0.16 * Math.sin(4 * Math.PI * bassFrequency * time)) *
    bassEnvelope *
    (time < 8 ? 0 : 0.11);

  const beatTime = beatFraction * secondsPerBeat;
  const kickPhase =
    2 *
    Math.PI *
    (46 * beatTime + (44 / 20) * (1 - Math.exp(-20 * beatTime)));
  const kick =
    Math.sin(kickPhase) *
    Math.exp(-beatTime * 13) *
    (time < 8 || (time >= 64 && time < 70) ? 0 : 0.24);

  const isBackbeat = beatIndex % 4 === 1 || beatIndex % 4 === 3;
  const snareNoise = deterministicNoise(frame, 17);
  const snare =
    (isBackbeat
      ? (snareNoise * 0.78 +
          Math.sin(2 * Math.PI * 185 * beatTime) * 0.22) *
        Math.exp(-beatTime * 22)
      : 0) * (time < 16 ? 0 : 0.095);

  const halfBeat = beat * 2;
  const halfBeatIndex = Math.floor(halfBeat);
  const halfBeatTime =
    (halfBeat - halfBeatIndex) * (secondsPerBeat / 2);
  const noise = deterministicNoise(frame, 53);
  const previousNoise = deterministicNoise(Math.max(0, frame - 1), 53);
  const hat =
    (noise - previousNoise) *
    Math.exp(-halfBeatTime * 68) *
    (halfBeatIndex % 2 === 1 ? 1 : 0.62) *
    (time < 16 || (time >= 64 && time < 70) ? 0 : 0.036);

  const melodyStep = Math.floor(beat / 2);
  const melodyTime = (beat % 2) * secondsPerBeat;
  const melodyFrequency = midiToFrequency(melody[melodyStep % melody.length]);
  const melodyGain =
    time >= 40 && time < 64
      ? Math.exp(-melodyTime * 3.7) * 0.038
      : 0;
  const lead = oscillator(melodyFrequency, time, 1.2) * melodyGain;
  const leadPan = 0.5 + 0.28 * Math.sin(melodyStep * 0.9);

  const arrangementGain =
    time >= 64 && time < 70 ? 0.72 : time >= 70 ? 1.04 : 1;
  const fade =
    smoothstep(0, 2.5, time) *
    (1 - smoothstep(durationSeconds - 5, durationSeconds, time));

  const center = bass + kick + snare + hat;
  const left =
    (padLeft +
      center +
      arp * (1 - arpPan * 0.45) +
      lead * (1 - leadPan * 0.5)) *
    arrangementGain *
    fade;
  const right =
    (padRight +
      center +
      arp * (0.55 + arpPan * 0.45) +
      lead * (0.5 + leadPan * 0.5)) *
    arrangementGain *
    fade;

  const leftSample = Math.round(clamp(left, -1, 1) * 32767);
  const rightSample = Math.round(clamp(right, -1, 1) * 32767);
  const offset = 44 + frame * CHANNELS * bytesPerSample;
  wav.writeInt16LE(leftSample, offset);
  wav.writeInt16LE(rightSample, offset + bytesPerSample);
}

writeFileSync(outputPath, wav);
