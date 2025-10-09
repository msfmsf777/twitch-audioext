import wasmAssetRelative from 'rubberband-wasm/dist/rubberband.wasm';
import type {
  BackgroundToContentMessage,
  ContentToBackgroundMessage
} from '../shared/messages';

const wasmAssetPath = chrome.runtime.getURL(wasmAssetRelative);
const workletModuleUrl = chrome.runtime.getURL('content/audio-worklet.js');

type MediaStatus = 'pending' | 'ready' | 'unsupported';

type ApplyStatePayload = {
  totalSemitoneOffset: number;
  totalSpeedPercent: number;
  manualSemitoneOffset: number;
  manualSpeedPercent: number;
  globalSemitoneOffset: number;
  globalSpeedPercent: number;
};

function postToBackground(message: ContentToBackgroundMessage): void {
  try {
    chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn('[content] Failed to post message', error);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

class AudioEngine {
  private context: AudioContext | null = null;
  private destination: GainNode | null = null;
  private bypassGain: GainNode | null = null;
  private workletGain: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private target: HTMLMediaElement | null = null;
  private workletReady = false;
  private pendingPitch: number | null = null;
  private previousMuted: boolean | null = null;
  private readonly workletReadyResolvers: Array<() => void> = [];

  constructor(private readonly workletUrl: string, private readonly wasmUrl: string) {}

  get attachedElement(): HTMLMediaElement | null {
    return this.target;
  }

  async attach(element: HTMLMediaElement): Promise<boolean> {
    if (this.target === element) {
      return true;
    }
    await this.ensureContext();
    if (!this.context) {
      return false;
    }
    this.detach();
    try {
      this.source = this.context.createMediaElementSource(element);
    } catch (error) {
      console.warn('[content] Failed to create media source', error);
      this.cleanupSource();
      return false;
    }
    if (!this.destination) {
      this.destination = this.context.createGain();
      this.destination.connect(this.context.destination);
    }
    if (!this.bypassGain) {
      this.bypassGain = this.context.createGain();
      this.bypassGain.gain.value = 1;
      this.bypassGain.connect(this.destination);
    }
    if (!this.workletGain) {
      this.workletGain = this.context.createGain();
      this.workletGain.gain.value = 0;
      this.workletGain.connect(this.destination);
    }
    if (!this.workletNode) {
      try {
        await this.loadWorklet();
      } catch (error) {
        console.warn('[content] Failed to load worklet', error);
        this.cleanupSource();
        return false;
      }
    }
    this.source.connect(this.bypassGain!);
    if (this.workletNode) {
      this.source.connect(this.workletNode);
    }
    this.target = element;
    this.previousMuted = element.muted;
    element.muted = true;
    if ('preservesPitch' in element) {
      try {
        (element as any).preservesPitch = true;
      } catch {
        // ignore
      }
    }
    if ('mozPreservesPitch' in element) {
      try {
        (element as any).mozPreservesPitch = true;
      } catch {
        // ignore
      }
    }
    if ('webkitPreservesPitch' in element) {
      try {
        (element as any).webkitPreservesPitch = true;
      } catch {
        // ignore
      }
    }
    if (this.workletReady && this.pendingPitch !== null) {
      this.sendPitch(this.pendingPitch);
      this.pendingPitch = null;
    }
    return true;
  }

  detach(): void {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // ignore
      }
      this.source = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
    }
    if (this.bypassGain) {
      this.bypassGain.gain.value = 1;
    }
    if (this.workletGain) {
      this.workletGain.gain.value = 0;
    }
    if (this.target) {
      try {
        this.target.muted = this.previousMuted ?? false;
      } catch {
        // ignore
      }
    }
    this.target = null;
    this.previousMuted = null;
  }

  private cleanupSource(): void {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // ignore
      }
    }
    this.source = null;
  }

  private async ensureContext(): Promise<void> {
    if (!this.context) {
      try {
        this.context = new AudioContext();
      } catch (error) {
        console.warn('[content] Failed to create AudioContext', error);
        return;
      }
    }
    if (this.context.state === 'suspended') {
      try {
        await this.context.resume();
      } catch (error) {
        console.warn('[content] Failed to resume AudioContext', error);
      }
    }
  }

  private async loadWorklet(): Promise<void> {
    if (!this.context) {
      return;
    }
    try {
      await this.context.audioWorklet.addModule(this.workletUrl);
      this.workletNode = new AudioWorkletNode(this.context, 'rubberband-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [Math.min(2, this.context.destination.channelCount)],
        processorOptions: {
          wasmUrl: this.wasmUrl,
          channelCount: Math.min(2, this.context.destination.channelCount)
        }
      });
      this.workletNode.port.onmessage = (event) => {
        const data = event.data as { type?: string };
        if (data?.type === 'ready') {
          this.workletReady = true;
          if (this.pendingPitch !== null) {
            this.sendPitch(this.pendingPitch);
            this.pendingPitch = null;
          }
          for (const resolve of this.workletReadyResolvers.splice(0)) {
            resolve();
          }
        }
      };
      this.workletNode.connect(this.workletGain!);
    } catch (error) {
      this.workletNode = null;
      throw error;
    }
  }

  async applyState(state: ApplyStatePayload): Promise<void> {
    const element = this.target;
    if (!element) {
      return;
    }
    await this.ensureContext();
    const desiredRate = clamp(state.totalSpeedPercent / 100, 0.5, 2);
    try {
      element.playbackRate = desiredRate;
      element.defaultPlaybackRate = desiredRate;
    } catch (error) {
      console.warn('[content] Failed to set playbackRate', error);
    }
    if (Math.abs(state.totalSemitoneOffset) < 0.001) {
      if (this.bypassGain) {
        this.bypassGain.gain.value = 1;
      }
      if (this.workletGain) {
        this.workletGain.gain.value = 0;
      }
      this.pendingPitch = 0;
      if (this.workletReady) {
        this.sendPitch(0);
      }
      return;
    }
    if (this.bypassGain) {
      this.bypassGain.gain.value = 0;
    }
    if (this.workletGain) {
      this.workletGain.gain.value = 1;
    }
    if (!this.workletReady) {
      this.pendingPitch = state.totalSemitoneOffset;
      await new Promise<void>((resolve) => this.workletReadyResolvers.push(resolve));
      return;
    }
    this.sendPitch(state.totalSemitoneOffset);
  }

  private sendPitch(value: number): void {
    if (!this.workletNode) {
      this.pendingPitch = value;
      return;
    }
    try {
      this.workletNode.port.postMessage({ type: 'update', pitch: value });
    } catch (error) {
      console.warn('[content] Failed to send pitch update', error);
      this.pendingPitch = value;
    }
  }
}

class MediaWatcher {
  private observer: MutationObserver | null = null;
  private seen = new WeakSet<HTMLMediaElement>();

  constructor(
    private readonly onCandidate: (element: HTMLMediaElement) => void,
    private readonly onNoMedia: () => void
  ) {}

  start(): void {
    this.scanExisting();
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) {
            return;
          }
          const media = node.matches('video, audio')
            ? [node as HTMLMediaElement]
            : Array.from(node.querySelectorAll('video, audio'));
          for (const el of media) {
            if (el instanceof HTMLMediaElement && !this.seen.has(el)) {
              this.seen.add(el);
              this.onCandidate(el);
            }
          }
        });
      }
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    if (!this.hasAnyMedia()) {
      this.onNoMedia();
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private scanExisting(): void {
    const elements = Array.from(document.querySelectorAll('video, audio')) as HTMLMediaElement[];
    if (elements.length === 0) {
      return;
    }
    for (const element of elements) {
      if (!this.seen.has(element)) {
        this.seen.add(element);
        this.onCandidate(element);
      }
    }
  }

  private hasAnyMedia(): boolean {
    return this.seen.size > 0 || document.querySelector('video, audio') !== null;
  }
}

let currentStatus: MediaStatus = 'pending';
let pendingState: ApplyStatePayload | null = null;
const engine = new AudioEngine(workletModuleUrl, wasmAssetPath);

function updateStatus(next: MediaStatus, reason?: string): void {
  if (currentStatus === next) {
    return;
  }
  currentStatus = next;
  postToBackground({ type: 'CONTENT_MEDIA_STATUS', status: next, reason });
}

async function handleCandidate(element: HTMLMediaElement): Promise<void> {
  const attached = await engine.attach(element);
  if (attached) {
    updateStatus('ready');
    if (pendingState) {
      await engine.applyState(pendingState);
    }
  } else {
    updateStatus('unsupported', 'attach-error');
  }
}

function handleNoMedia(): void {
  if (!engine.attachedElement) {
    updateStatus('unsupported', 'no-media');
  }
}

function handleBackgroundMessage(message: BackgroundToContentMessage): void {
  switch (message.type) {
    case 'AUDIO_APPLY': {
      const payload: ApplyStatePayload = {
        totalSemitoneOffset: message.payload.totalSemitoneOffset,
        totalSpeedPercent: message.payload.totalSpeedPercent,
        manualSemitoneOffset: message.payload.manualSemitoneOffset,
        manualSpeedPercent: message.payload.manualSpeedPercent,
        globalSemitoneOffset: message.payload.globalSemitoneOffset,
        globalSpeedPercent: message.payload.globalSpeedPercent
      };
      if (engine.attachedElement) {
        void engine.applyState(payload);
        pendingState = payload;
      } else {
        pendingState = payload;
      }
      break;
    }
    case 'PING':
      postToBackground({ type: 'CONTENT_PONG' });
      break;
    default:
      break;
  }
}

chrome.runtime.onMessage.addListener((raw: unknown) => {
  const message = raw as BackgroundToContentMessage;
  if (!message || typeof message !== 'object') {
    return;
  }
  if (!('type' in message)) {
    return;
  }
  handleBackgroundMessage(message);
});

function init(): void {
  postToBackground({ type: 'CONTENT_READY' });
  postToBackground({ type: 'CONTENT_MEDIA_STATUS', status: 'pending' });
  const watcher = new MediaWatcher(handleCandidate, handleNoMedia);
  watcher.start();
}

init();
