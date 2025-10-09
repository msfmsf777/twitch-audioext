import {
  RubberBandInterface,
  RubberBandOption,
  type RubberBandState
} from 'rubberband-wasm/dist/index.esm.js';

type ProcessorMessage =
  | { type: 'update'; pitch: number }
  | { type: 'reset' };

interface OutputChunk {
  data: Float32Array[];
  offset: number;
}

declare const sampleRate: number;

declare interface AudioWorkletProcessorGlobalScope {
  sampleRate: number;
}

class RubberBandProcessor extends AudioWorkletProcessor {
  private readonly wasmBytes: ArrayBuffer | null;
  private readonly channelCount: number;
  private rb: RubberBandInterface | null = null;
  private state: RubberBandState | null = null;
  private inputArrayPtr: number | null = null;
  private outputArrayPtr: number | null = null;
  private inputChannelPtrs: number[] = [];
  private outputChannelPtrs: number[] = [];
  private inputCapacity = 0;
  private outputCapacity = 0;
  private readonly outputChunks: OutputChunk[] = [];
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private pendingPitch = 0;
  private parameterDirty = true;

  constructor(
    options: AudioWorkletNodeOptions & { processorOptions: { wasmBytes: ArrayBuffer; channelCount?: number } }
  ) {
    super();
    this.wasmBytes = options.processorOptions?.wasmBytes ?? null;
    this.channelCount = options.processorOptions?.channelCount ?? options.outputChannelCount?.[0] ?? 2;
    this.port.onmessage = (event) => this.handleMessage(event.data as ProcessorMessage);
    this.initializing = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      if (!(this.wasmBytes instanceof ArrayBuffer)) {
        throw new Error('Missing Rubber Band WASM bytes');
      }
      const module = await WebAssembly.compile(this.wasmBytes);
      this.rb = await RubberBandInterface.initialize(module);
      const options =
        RubberBandOption.RubberBandOptionProcessRealTime |
        RubberBandOption.RubberBandOptionStretchPrecise |
        RubberBandOption.RubberBandOptionTransientsSmooth |
        RubberBandOption.RubberBandOptionPitchHighQuality |
        RubberBandOption.RubberBandOptionFormantPreserved |
        RubberBandOption.RubberBandOptionChannelsTogether;
      this.state = this.rb.rubberband_new(sampleRate, this.channelCount, options, 1, 1);
      this.ensureInputCapacity(256);
      const required = this.rb.rubberband_get_samples_required(this.state);
      this.ensureOutputCapacity(Math.max(required, 256));
      this.initialized = true;
      this.parameterDirty = true;
      this.port.postMessage({ type: 'ready' });
    } catch (error) {
      console.error('[worklet] Failed to initialize Rubber Band', error);
      this.port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private dispose(): void {
    if (!this.rb) {
      return;
    }
    for (const ptr of this.inputChannelPtrs) {
      this.rb.free(ptr);
    }
    for (const ptr of this.outputChannelPtrs) {
      this.rb.free(ptr);
    }
    if (this.inputArrayPtr !== null) {
      this.rb.free(this.inputArrayPtr);
    }
    if (this.outputArrayPtr !== null) {
      this.rb.free(this.outputArrayPtr);
    }
    if (this.state !== null) {
      this.rb.rubberband_delete(this.state);
    }
    this.inputChannelPtrs = [];
    this.outputChannelPtrs = [];
    this.inputArrayPtr = null;
    this.outputArrayPtr = null;
    this.state = null;
    this.initialized = false;
  }

  private ensureInputCapacity(frames: number): void {
    if (!this.rb) return;
    if (frames <= this.inputCapacity) {
      return;
    }
    if (this.inputArrayPtr !== null) {
      for (const ptr of this.inputChannelPtrs) {
        this.rb.free(ptr);
      }
      this.inputChannelPtrs = [];
      this.rb.free(this.inputArrayPtr);
      this.inputArrayPtr = null;
    }
    this.inputArrayPtr = this.rb.malloc(this.channelCount * 4);
    for (let channel = 0; channel < this.channelCount; channel += 1) {
      const bufferPtr = this.rb.malloc(frames * 4);
      this.inputChannelPtrs.push(bufferPtr);
      this.rb.memWritePtr(this.inputArrayPtr + channel * 4, bufferPtr);
    }
    this.inputCapacity = frames;
  }

  private ensureOutputCapacity(frames: number): void {
    if (!this.rb) return;
    if (frames <= this.outputCapacity) {
      return;
    }
    if (this.outputArrayPtr !== null) {
      for (const ptr of this.outputChannelPtrs) {
        this.rb.free(ptr);
      }
      this.outputChannelPtrs = [];
      this.rb.free(this.outputArrayPtr);
      this.outputArrayPtr = null;
    }
    this.outputArrayPtr = this.rb.malloc(this.channelCount * 4);
    for (let channel = 0; channel < this.channelCount; channel += 1) {
      const bufferPtr = this.rb.malloc(frames * 4);
      this.outputChannelPtrs.push(bufferPtr);
      this.rb.memWritePtr(this.outputArrayPtr + channel * 4, bufferPtr);
    }
    this.outputCapacity = frames;
  }

  private handleMessage(message: ProcessorMessage): void {
    if (message.type === 'reset') {
      this.pendingPitch = 0;
      this.parameterDirty = true;
      if (this.rb && this.state !== null) {
        this.rb.rubberband_reset(this.state);
      }
      return;
    }
    if (message.type === 'update') {
      this.pendingPitch = message.pitch;
      this.parameterDirty = true;
    }
  }

  private updateParameters(): void {
    if (!this.parameterDirty || !this.rb || this.state === null) {
      return;
    }
    const pitchScale = Math.pow(2, this.pendingPitch / 12);
    this.rb.rubberband_set_pitch_scale(this.state, pitchScale);
    this.rb.rubberband_set_time_ratio(this.state, 1);
    this.parameterDirty = false;
  }

  private collectAvailable(): void {
    if (!this.rb || this.state === null) {
      return;
    }
    while (true) {
      const available = this.rb.rubberband_available(this.state);
      if (available <= 0) {
        break;
      }
      const chunkSize = Math.min(available, this.outputCapacity);
      if (chunkSize <= 0) {
        break;
      }
      const retrieved = this.rb.rubberband_retrieve(this.state, this.outputArrayPtr!, chunkSize);
      if (retrieved <= 0) {
        break;
      }
      const chunk: Float32Array[] = [];
      for (let channel = 0; channel < this.channelCount; channel += 1) {
        const ptr = this.outputChannelPtrs[channel];
        const slice = this.rb.memReadF32(ptr, retrieved);
        chunk.push(new Float32Array(slice));
      }
      this.outputChunks.push({ data: chunk, offset: 0 });
    }
  }

  private renderFromQueue(output: Float32Array[]): void {
    const frames = output[0]?.length ?? 0;
    for (let frame = 0; frame < frames; frame += 1) {
      let chunk = this.outputChunks[0];
      if (!chunk) {
        for (let channel = 0; channel < output.length; channel += 1) {
          output[channel][frame] = 0;
        }
        continue;
      }
      for (let channel = 0; channel < output.length; channel += 1) {
        const data = chunk.data[channel];
        output[channel][frame] = data[chunk.offset] ?? 0;
      }
      chunk.offset += 1;
      if (chunk.offset >= chunk.data[0].length) {
        this.outputChunks.shift();
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }
    const input = inputs[0];
    if (!input || input.length === 0) {
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel].fill(0);
      }
      return true;
    }

    if (this.initializing) {
      void this.initializing;
    }

    if (!this.initialized || !this.rb || this.state === null || this.inputArrayPtr === null) {
      for (let channel = 0; channel < output.length; channel += 1) {
        const source = input[channel] ?? input[0];
        output[channel].set(source ?? new Float32Array(output[channel].length));
      }
      return true;
    }

    const frames = input[0]?.length ?? output[0].length;
    this.ensureInputCapacity(frames);
    this.ensureOutputCapacity(Math.max(this.outputCapacity, frames));
    this.updateParameters();

    for (let channel = 0; channel < this.channelCount; channel += 1) {
      const source = input[channel] ?? input[0];
      const ptr = this.inputChannelPtrs[channel];
      if (source) {
        this.rb.memWrite(ptr, source);
      } else {
        this.rb.memWrite(ptr, new Float32Array(frames));
      }
    }

    this.rb.rubberband_process(this.state, this.inputArrayPtr, frames, 0);
    this.collectAvailable();
    this.renderFromQueue(output);
    return true;
  }

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [];
  }
}

registerProcessor('rubberband-processor', RubberBandProcessor);
