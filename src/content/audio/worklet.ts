/* eslint-disable no-restricted-globals */
import { RubberBandInterface, RubberBandOption } from 'rubberband-wasm/dist/index.esm.js';
import wasmBinary from 'rubberband-wasm/dist/rubberband.wasm';

const PROCESS_FRAMES = 128;
const INITIAL_OUTPUT_FRAMES = 2048;
const PITCH_PARAM = 'pitch';

type RubberBandState = number;

interface PendingChunk {
  channels: Float32Array[];
  frames: number;
  offset: number;
}

const wasmModulePromise = WebAssembly.compile(wasmBinary);

function semitoneToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

class RubberBandPitchProcessor extends AudioWorkletProcessor {
  private interfacePromise = wasmModulePromise.then((module) => RubberBandInterface.initialize(module));
  private rubberBand: RubberBandInterface | null = null;
  private state: RubberBandState | null = null;
  private channelCount = 0;
  private inputPointers: number[] = [];
  private outputPointers: number[] = [];
  private inputPointerArray = 0;
  private outputPointerArray = 0;
  private outputBufferSize = INITIAL_OUTPUT_FRAMES;
  private pendingChunks: PendingChunk[] = [];
  private currentPitchRatio = 1;
  private bypass = true;
  private initializing = false;

  static override get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: PITCH_PARAM,
        defaultValue: 0,
        minValue: -24,
        maxValue: 24,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor() {
    super();
    this.interfacePromise
      .then((instance) => {
        this.rubberBand = instance;
      })
      .catch((error) => {
        console.error('[worklet] Failed to initialize Rubber Band', error);
      });

    this.port.onmessage = (event) => {
      if (event.data?.type === 'RESET') {
        this.resetState();
      }
    };
  }

  private freeBuffers(): void {
    if (!this.rubberBand) {
      return;
    }
    for (const pointer of this.inputPointers) {
      this.rubberBand.free(pointer);
    }
    for (const pointer of this.outputPointers) {
      this.rubberBand.free(pointer);
    }
    this.inputPointers = [];
    this.outputPointers = [];
    if (this.inputPointerArray) {
      this.rubberBand.free(this.inputPointerArray);
      this.inputPointerArray = 0;
    }
    if (this.outputPointerArray) {
      this.rubberBand.free(this.outputPointerArray);
      this.outputPointerArray = 0;
    }
  }

  private writePointerArray(basePointer: number, pointers: number[]): void {
    if (!this.rubberBand) {
      return;
    }
    for (let index = 0; index < pointers.length; index += 1) {
      this.rubberBand.memWritePtr(basePointer + index * 4, pointers[index]);
    }
  }

  private allocateBuffers(channelCount: number, outputFrames: number): void {
    if (!this.rubberBand) {
      return;
    }
    this.freeBuffers();
    this.inputPointers = new Array(channelCount);
    this.outputPointers = new Array(channelCount);
    for (let channel = 0; channel < channelCount; channel += 1) {
      this.inputPointers[channel] = this.rubberBand.malloc(PROCESS_FRAMES * 4);
      this.outputPointers[channel] = this.rubberBand.malloc(outputFrames * 4);
    }
    this.inputPointerArray = this.rubberBand.malloc(channelCount * 4);
    this.outputPointerArray = this.rubberBand.malloc(channelCount * 4);
    this.writePointerArray(this.inputPointerArray, this.inputPointers);
    this.writePointerArray(this.outputPointerArray, this.outputPointers);
    this.outputBufferSize = outputFrames;
  }

  private async ensureState(channelCount: number): Promise<boolean> {
    if (!this.rubberBand && !this.initializing) {
      this.initializing = true;
      try {
        this.rubberBand = await this.interfacePromise;
      } catch (error) {
        console.error('[worklet] Failed to initialize Rubber Band', error);
        this.rubberBand = null;
      } finally {
        this.initializing = false;
      }
    }
    if (!this.rubberBand) {
      return false;
    }
    if (!this.state || this.channelCount !== channelCount) {
      if (this.state) {
        this.rubberBand.rubberband_delete(this.state);
      }
      this.allocateBuffers(channelCount, INITIAL_OUTPUT_FRAMES);
      const options =
        RubberBandOption.RubberBandOptionProcessRealTime |
        RubberBandOption.RubberBandOptionPitchHighQuality |
        RubberBandOption.RubberBandOptionFormantPreserved |
        RubberBandOption.RubberBandOptionSmoothingOn |
        RubberBandOption.RubberBandOptionTransientsMixed |
        RubberBandOption.RubberBandOptionStretchPrecise |
        RubberBandOption.RubberBandOptionChannelsTogether;
      this.state = this.rubberBand.rubberband_new(sampleRate, channelCount, options, 1, 1);
      this.rubberBand.rubberband_set_max_process_size(this.state, PROCESS_FRAMES);
      this.channelCount = channelCount;
      this.pendingChunks = [];
      this.currentPitchRatio = 1;
    }
    return true;
  }

  private ensureOutputCapacity(frames: number): void {
    if (!this.rubberBand || frames <= this.outputBufferSize) {
      return;
    }
    const nextSize = Math.max(frames, this.outputBufferSize * 2);
    this.allocateBuffers(this.channelCount, nextSize);
  }

  private enqueueChunk(frames: number): void {
    if (!this.rubberBand) {
      return;
    }
    const channels: Float32Array[] = new Array(this.channelCount);
    for (let channel = 0; channel < this.channelCount; channel += 1) {
      const dataView = this.rubberBand.memReadF32(this.outputPointers[channel], frames);
      channels[channel] = new Float32Array(dataView);
    }
    this.pendingChunks.push({ channels, frames, offset: 0 });
  }

  private fillOutput(output: Float32Array[], frames: number): void {
    for (const channel of output) {
      channel.fill(0);
    }
    let written = 0;
    while (written < frames && this.pendingChunks.length > 0) {
      const chunk = this.pendingChunks[0];
      const remainingInChunk = chunk.frames - chunk.offset;
      const needed = frames - written;
      const toCopy = Math.min(remainingInChunk, needed);
      for (let channel = 0; channel < output.length; channel += 1) {
        const source = chunk.channels[channel].subarray(chunk.offset, chunk.offset + toCopy);
        output[channel].set(source, written);
      }
      chunk.offset += toCopy;
      written += toCopy;
      if (chunk.offset >= chunk.frames) {
        this.pendingChunks.shift();
      }
    }
  }

  private copyInputToOutput(input: Float32Array[], output: Float32Array[]): void {
    for (let channel = 0; channel < output.length; channel += 1) {
      const source = input[channel] ?? new Float32Array(output[channel].length);
      output[channel].set(source.subarray(0, output[channel].length));
    }
  }

  private processThroughRubberBand(input: Float32Array[], pitchSemitones: number, frames: number): void {
    if (!this.rubberBand || !this.state) {
      return;
    }
    const pitchRatio = semitoneToRatio(pitchSemitones);
    if (Math.abs(pitchRatio - this.currentPitchRatio) > 1e-4) {
      this.rubberBand.rubberband_set_pitch_scale(this.state, pitchRatio);
      this.currentPitchRatio = pitchRatio;
    }
    for (let channel = 0; channel < this.channelCount; channel += 1) {
      const pointer = this.inputPointers[channel];
      const data = input[channel];
      if (data) {
        this.rubberBand.memWrite(pointer, data);
      } else {
        this.rubberBand.memWrite(pointer, new Float32Array(frames));
      }
    }
    this.rubberBand.rubberband_process(this.state, this.inputPointerArray, frames, 0);
    let available = this.rubberBand.rubberband_available(this.state);
    while (available > 0) {
      this.ensureOutputCapacity(available);
      const batch = Math.min(available, this.outputBufferSize);
      this.rubberBand.rubberband_retrieve(this.state, this.outputPointerArray, batch);
      this.enqueueChunk(batch);
      available -= batch;
    }
  }

  private resetState(): void {
    if (this.rubberBand && this.state) {
      this.rubberBand.rubberband_reset(this.state);
    }
    this.pendingChunks = [];
    this.currentPitchRatio = 1;
  }

  override process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }

    const channelCount = input?.length ?? 0;
    if (channelCount === 0) {
      for (const channel of output) {
        channel.fill(0);
      }
      return true;
    }

    const frames = output[0].length;
    if (!this.ensureState(channelCount)) {
      this.copyInputToOutput(input, output);
      return true;
    }

    const pitchValues = parameters[PITCH_PARAM];
    const semitone = pitchValues?.[0] ?? 0;

    if (Math.abs(semitone) < 1e-4) {
      if (!this.bypass) {
        this.resetState();
      }
      this.bypass = true;
      this.copyInputToOutput(input, output);
      return true;
    }

    this.bypass = false;
    this.processThroughRubberBand(input, semitone, frames);
    this.fillOutput(output, frames);
    return true;
  }

  override finalize(): void {
    if (this.rubberBand && this.state) {
      this.rubberBand.rubberband_delete(this.state);
    }
    this.freeBuffers();
    this.state = null;
  }
}

registerProcessor('rubberband-pitch-shifter', RubberBandPitchProcessor);

