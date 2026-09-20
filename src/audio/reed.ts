/**
 * Voicing a tremolo harmonica.
 *
 * The obvious approach -- a sawtooth through a lowpass with a fast attack -- comes out
 * sounding struck, like a cheap piano patch, for three reasons worth naming because each
 * suggests its own fix:
 *
 *   1. A sawtooth rolls off as 1/n forever, so it is buzzy up top and its harmonic balance
 *      is nothing like a free reed's. A reed has a strong second and third partial, a dip
 *      around the fourth, and comparatively little above the eighth. That is a specific
 *      shape, so it is specified here as a table and handed to a PeriodicWave.
 *   2. A 12ms attack reads as a hammer. A reed has to be set moving by air and takes
 *      30-50ms to reach full amplitude, with the brightness arriving after the fundamental
 *      rather than with it.
 *   3. Real ones are blown through a cupped body, which imposes fixed formants that do not
 *      move with pitch, and they leak air the whole time. Without the breath noise and the
 *      formants the tone is synthetic however good the harmonic table is.
 */

/**
 * Relative amplitudes of the first sixteen partials.
 *
 * Shaped after the spectrum of a blown tremolo reed: fundamental strong, second and third
 * nearly as loud (this is what gives the instrument its reedy bite), a dip at the fourth,
 * then a steady fall with a small lift around the seventh where the cover plates resonate.
 */
const REED_PARTIALS = [
  1.00, 0.72, 0.58, 0.22, 0.26, 0.17, 0.19, 0.09,
  0.07, 0.05, 0.045, 0.03, 0.025, 0.018, 0.014, 0.01,
];

/** Cents between the two reeds of a pair; about four beats a second in the middle register. */
export const TREMOLO_DETUNE_CENTS = 16;

/**
 * Body formants, fixed in absolute frequency: they do not track the note being played.
 *
 * Boosts are kept modest on purpose. Peaking filters multiply, so a pair at +5.5dB and
 * +4dB stacks to nearly 3x on top of the two summed oscillators -- enough to drive the
 * output past full scale and clip, which sounds harsh and undoes the point of voicing it
 * carefully in the first place.
 */
const FORMANTS = [
  { frequency: 780, q: 1.1, gain: 3.0 },
  { frequency: 2100, q: 1.4, gain: 2.5 },
];

/** Halves the summed oscillator pair back to roughly unit amplitude. */
const PAIR_MIX = 0.5;

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Builds the reed waveform once; PeriodicWave is immutable and safe to share. */
export function createReedWave(context: BaseAudioContext): PeriodicWave {
  const real = new Float32Array(REED_PARTIALS.length + 1);
  const imag = new Float32Array(REED_PARTIALS.length + 1);
  // Sine phase for every partial: a reed's partials are not phase-aligned the way a
  // sawtooth's are, and aligned phases are part of what makes a saw sound buzzy.
  REED_PARTIALS.forEach((amplitude, i) => { imag[i + 1] = amplitude; });
  return context.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** A short loop of white noise, reused by every note for the breath component. */
export function createBreathNoise(context: BaseAudioContext, seconds = 2): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  // Slightly lowpassed noise, via a one-pole average, so it reads as air rather than hiss.
  let previous = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    previous = previous * 0.6 + white * 0.4;
    data[i] = previous;
  }
  return buffer;
}

export interface ReedVoiceOptions {
  midi: number;
  /** AudioContext time to start. */
  when: number;
  /** Seconds the note is held. */
  duration: number;
  gain: number;
  wave: PeriodicWave;
  noise: AudioBuffer;
  destination: AudioNode;
}

/**
 * Schedules one note and cleans up after itself.
 *
 * Every node is created per note rather than pooled. That is more allocation than a
 * synth engine would normally do, but a melody line is a few notes a second and the
 * scheduler only ever looks a fraction of a second ahead, so the cost is irrelevant next
 * to the simplicity of never having to reset voice state.
 */
export function playReed(context: BaseAudioContext, options: ReedVoiceOptions): void {
  const { midi, when, duration, gain, wave, noise, destination } = options;
  const frequency = midiToFrequency(midi);

  const voice = context.createGain();
  voice.gain.value = 0;

  // Formants first: they colour everything, tone and breath alike.
  let chainInput: AudioNode = voice;
  const formantNodes = FORMANTS.map(({ frequency: f, q, gain: g }) => {
    const peak = context.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = f;
    peak.Q.value = q;
    peak.gain.value = g;
    return peak;
  });

  // A gentle lowpass that opens slightly as the note speaks, so brightness arrives after
  // the fundamental the way it does on a real reed rather than all at once.
  const brightness = context.createBiquadFilter();
  brightness.type = 'lowpass';
  brightness.Q.value = 0.7;
  brightness.frequency.setValueAtTime(Math.min(3200, frequency * 3), when);
  brightness.frequency.linearRampToValueAtTime(Math.min(9000, frequency * 9), when + 0.09);

  let tail: AudioNode = brightness;
  for (const node of formantNodes) {
    tail.connect(node);
    tail = node;
  }
  tail.connect(destination);
  chainInput.connect(brightness);

  // The tremolo pair, mixed back down so two oscillators do not mean twice the level.
  const pair = context.createGain();
  pair.gain.value = PAIR_MIX;
  pair.connect(voice);

  const oscillators: OscillatorNode[] = [];
  for (const detune of [-TREMOLO_DETUNE_CENTS / 2, TREMOLO_DETUNE_CENTS / 2]) {
    const osc = context.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = frequency;
    osc.detune.value = detune;
    osc.connect(pair);
    oscillators.push(osc);
  }

  // Breath: filtered noise tracking the note, loud during the attack and then receding.
  const breath = context.createBufferSource();
  breath.buffer = noise;
  breath.loop = true;
  const breathFilter = context.createBiquadFilter();
  breathFilter.type = 'bandpass';
  breathFilter.frequency.value = Math.min(4000, frequency * 2.5);
  breathFilter.Q.value = 0.8;
  const breathGain = context.createGain();
  breathGain.gain.value = 0;
  breath.connect(breathFilter);
  breathFilter.connect(breathGain);
  breathGain.connect(voice);

  // Envelope. A reed is set moving by air: it swells rather than striking, holds while
  // the breath lasts, and stops fairly promptly when the air does.
  const attack = Math.min(0.045, duration * 0.4);
  const release = Math.min(0.09, duration * 0.35);
  const sustainUntil = Math.max(when + attack, when + duration - release);

  voice.gain.setValueAtTime(0, when);
  voice.gain.linearRampToValueAtTime(gain, when + attack);
  voice.gain.setValueAtTime(gain, sustainUntil);
  voice.gain.linearRampToValueAtTime(0, when + duration + release);

  // Breath is proportionally loudest at the onset, which is where the air noise actually is.
  breathGain.gain.setValueAtTime(0, when);
  breathGain.gain.linearRampToValueAtTime(gain * 0.22, when + attack * 0.5);
  breathGain.gain.linearRampToValueAtTime(gain * 0.05, when + Math.min(duration, attack + 0.12));
  breathGain.gain.linearRampToValueAtTime(0, when + duration + release);

  // A shallow, slowish vibrato on top of the tremolo beating: breath is never perfectly
  // steady, and without this a long note sits dead still and sounds synthetic.
  if (duration > 0.35) {
    const lfo = context.createOscillator();
    const depth = context.createGain();
    lfo.frequency.value = 5.2;
    depth.gain.value = gain * 0.07;
    lfo.connect(depth);
    depth.connect(voice.gain);
    lfo.start(when + 0.12);
    lfo.stop(when + duration + release);
  }

  const stopAt = when + duration + release + 0.02;
  for (const osc of oscillators) { osc.start(when); osc.stop(stopAt); }
  breath.start(when);
  breath.stop(stopAt);

  // Release the graph once it has finished sounding.
  oscillators[0]!.onended = () => {
    pair.disconnect();
    voice.disconnect();
    brightness.disconnect();
    for (const node of formantNodes) node.disconnect();
    breathGain.disconnect();
    breathFilter.disconnect();
  };
}
