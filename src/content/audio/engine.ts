import type { MediaAvailabilityState } from '../../shared/state';

const MEDIA_QUERY = 'video, audio';
const AVAILABILITY_DEBOUNCE_MS = 200;

type MediaAvailabilityReason = MediaAvailabilityState['reason'];

interface MediaAttachment {
  element: HTMLMediaElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  wasMuted: boolean;
  preservesPitch?: boolean;
  mozPreservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
}

export class AudioEngine {
  private audioContext: AudioContext | null = null;
  private inputGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private pitchNode: AudioWorkletNode | null = null;
  private pitchNodeConnected = false;
  private workletLoaded = false;
  private attachments: Map<HTMLMediaElement, MediaAttachment> = new Map();
  private observer: MutationObserver | null = null;
  private scheduledScan = false;
  private scanning = false;
  private rescanNeeded = false;
  private availability: MediaAvailabilityState = {
    hasAnyMedia: false,
    hasUsableMedia: false,
    reason: 'no_media'
  };
  private availabilityListener: (state: MediaAvailabilityState) => void;
  private availabilityTimer: number | null = null;
  private pendingAvailability: MediaAvailabilityState | null = null;
  private targetPitch = 0;
  private targetSpeed = 100;

  constructor(listener: (state: MediaAvailabilityState) => void) {
    this.availabilityListener = listener;
  }

  async start(): Promise<void> {
    if (this.observer) {
      return;
    }
    this.scheduleScan();
    this.observer = new MutationObserver(() => {
      this.scheduleScan();
    });
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'currentSrc']
    });
    window.addEventListener('pageshow', () => this.scheduleScan());
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  private notifyAvailability(state: MediaAvailabilityState): void {
    if (
      this.availability.hasAnyMedia === state.hasAnyMedia &&
      this.availability.hasUsableMedia === state.hasUsableMedia &&
      this.availability.reason === state.reason
    ) {
      return;
    }
    this.availability = state;
    this.pendingAvailability = state;
    if (this.availabilityTimer) {
      return;
    }
    this.availabilityTimer = window.setTimeout(() => {
      this.availabilityTimer = null;
      if (this.pendingAvailability) {
        this.availabilityListener(this.pendingAvailability);
        this.pendingAvailability = null;
      }
    }, AVAILABILITY_DEBOUNCE_MS);
  }

  private scheduleScan(): void {
    if (this.scheduledScan) {
      return;
    }
    this.scheduledScan = true;
    queueMicrotask(() => {
      this.scheduledScan = false;
      void this.performScan();
    });
  }

  private async performScan(): Promise<void> {
    if (this.scanning) {
      this.rescanNeeded = true;
      return;
    }
    this.scanning = true;
    try {
      await this.scanMediaElements();
    } finally {
      this.scanning = false;
      if (this.rescanNeeded) {
        this.rescanNeeded = false;
        this.scheduleScan();
      }
    }
  }

  private async ensureContext(): Promise<AudioContext> {
    if (this.audioContext) {
      if (this.audioContext.state === 'suspended') {
        try {
          await this.audioContext.resume();
        } catch (error) {
          console.debug('[content] Failed to resume AudioContext', error);
        }
      }
      return this.audioContext;
    }
    const context = new AudioContext({ latencyHint: 'interactive' });
    const inputGain = context.createGain();
    const masterGain = context.createGain();
    inputGain.connect(masterGain);
    masterGain.connect(context.destination);
    this.audioContext = context;
    this.inputGain = inputGain;
    this.masterGain = masterGain;
    return context;
  }

  private getInputGain(): GainNode | null {
    return this.inputGain;
  }

  private async ensurePitchNode(): Promise<AudioWorkletNode> {
    const context = await this.ensureContext();
    if (!this.workletLoaded) {
      try {
        await context.audioWorklet.addModule(chrome.runtime.getURL('content/audio-worklet.js'));
        this.workletLoaded = true;
      } catch (error) {
        console.error('[content] Failed to load audio worklet module', error);
        throw error;
      }
    }
    if (!this.pitchNode) {
      this.pitchNode = new AudioWorkletNode(context, 'rubberband-pitch-shifter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCountMode: 'max',
        channelInterpretation: 'speakers'
      });
    }
    return this.pitchNode;
  }

  private disconnectPitchNode(): void {
    if (!this.pitchNodeConnected || !this.inputGain || !this.masterGain || !this.pitchNode) {
      return;
    }
    try {
      this.inputGain.disconnect(this.pitchNode);
    } catch (error) {
      console.debug('[content] Failed to disconnect input from pitch node', error);
    }
    try {
      this.pitchNode.disconnect(this.masterGain);
    } catch (error) {
      console.debug('[content] Failed to disconnect pitch node output', error);
    }
    try {
      this.inputGain.connect(this.masterGain);
    } catch (error) {
      console.debug('[content] Failed to reconnect bypass path', error);
    }
    this.pitchNode.port.postMessage({ type: 'RESET' });
    this.pitchNodeConnected = false;
  }

  private async connectPitchNode(): Promise<void> {
    if (this.pitchNodeConnected) {
      return;
    }
    const pitchNode = await this.ensurePitchNode();
    const inputGain = this.inputGain;
    const masterGain = this.masterGain;
    if (!inputGain || !masterGain) {
      return;
    }
    try {
      inputGain.disconnect(masterGain);
    } catch (error) {
      void error;
    }
    inputGain.connect(pitchNode);
    pitchNode.connect(masterGain);
    this.pitchNodeConnected = true;
  }

  private storeOriginalPitchState(element: HTMLMediaElement): Pick<MediaAttachment, 'preservesPitch' | 'mozPreservesPitch' | 'webkitPreservesPitch'> {
    const anyElement = element as any;
    return {
      preservesPitch: 'preservesPitch' in element ? (anyElement.preservesPitch as boolean) : undefined,
      mozPreservesPitch: 'mozPreservesPitch' in anyElement ? (anyElement.mozPreservesPitch as boolean) : undefined,
      webkitPreservesPitch: 'webkitPreservesPitch' in anyElement ? (anyElement.webkitPreservesPitch as boolean) : undefined
    };
  }

  private applyPitchPreservation(element: HTMLMediaElement): void {
    const anyElement = element as any;
    if ('preservesPitch' in element) {
      anyElement.preservesPitch = true;
    }
    if ('mozPreservesPitch' in anyElement) {
      anyElement.mozPreservesPitch = true;
    }
    if ('webkitPreservesPitch' in anyElement) {
      anyElement.webkitPreservesPitch = true;
    }
  }

  private restorePitchPreservation(element: HTMLMediaElement, attachment: MediaAttachment): void {
    const anyElement = element as any;
    if ('preservesPitch' in element && typeof attachment.preservesPitch === 'boolean') {
      anyElement.preservesPitch = attachment.preservesPitch;
    }
    if ('mozPreservesPitch' in anyElement && typeof attachment.mozPreservesPitch === 'boolean') {
      anyElement.mozPreservesPitch = attachment.mozPreservesPitch;
    }
    if ('webkitPreservesPitch' in anyElement && typeof attachment.webkitPreservesPitch === 'boolean') {
      anyElement.webkitPreservesPitch = attachment.webkitPreservesPitch;
    }
  }

  private async attachElement(element: HTMLMediaElement): Promise<'attached' | 'error'> {
    try {
      const context = await this.ensureContext();
      const inputGain = this.getInputGain();
      if (!inputGain) {
        return 'error';
      }
      const source = context.createMediaElementSource(element);
      const gain = context.createGain();
      source.connect(gain);
      gain.connect(inputGain);
      const originalPitch = this.storeOriginalPitchState(element);
      const attachment: MediaAttachment = {
        element,
        source,
        gain,
        wasMuted: element.muted,
        ...originalPitch
      };
      element.muted = true;
      this.applyPitchPreservation(element);
      this.attachments.set(element, attachment);
      this.applySpeedToElement(element);
      return 'attached';
    } catch (error) {
      console.debug('[content] Failed to attach media element', error);
      return 'error';
    }
  }

  private detachElement(element: HTMLMediaElement): void {
    const attachment = this.attachments.get(element);
    if (!attachment) {
      return;
    }
    try {
      attachment.source.disconnect();
    } catch (error) {
      void error;
    }
    try {
      attachment.gain.disconnect();
    } catch (error) {
      void error;
    }
    element.muted = attachment.wasMuted;
    this.restorePitchPreservation(element, attachment);
    this.attachments.delete(element);
  }

  private applySpeedToElement(element: HTMLMediaElement): void {
    const rate = this.targetSpeed / 100;
    if (Number.isFinite(rate) && element.playbackRate !== rate) {
      try {
        element.playbackRate = rate;
      } catch (error) {
        console.debug('[content] Failed to set playbackRate', error);
      }
    }
    if (Number.isFinite(rate) && element.defaultPlaybackRate !== rate) {
      element.defaultPlaybackRate = rate;
    }
  }

  private applySpeedToAttachments(): void {
    for (const attachment of this.attachments.values()) {
      this.applySpeedToElement(attachment.element);
    }
  }

  private determineAvailability(hasAny: boolean, attachErrors: number): MediaAvailabilityReason {
    if (!hasAny) {
      return 'no_media';
    }
    if (this.attachments.size === 0 && attachErrors > 0) {
      return 'drm_cors';
    }
    if (this.attachments.size === 0) {
      return 'no_media';
    }
    return 'none';
  }

  private cleanupDetached(elements: Set<HTMLMediaElement>): void {
    for (const [element] of this.attachments) {
      if (!elements.has(element)) {
        this.detachElement(element);
      }
    }
  }

  private async scanMediaElements(): Promise<void> {
    const elements = Array.from(document.querySelectorAll<HTMLMediaElement>(MEDIA_QUERY));
    const elementSet = new Set(elements);
    this.cleanupDetached(elementSet);

    let attachErrors = 0;
    if (elements.length > 0) {
      await this.ensureContext();
      for (const element of elements) {
        if (this.attachments.has(element)) {
          this.applySpeedToElement(element);
          continue;
        }
        const result = await this.attachElement(element);
        if (result === 'error') {
          attachErrors += 1;
        }
      }
    }

    const hasAny = elements.length > 0;
    const hasUsable = this.attachments.size > 0;
    const reason = this.determineAvailability(hasAny, attachErrors);
    this.notifyAvailability({ hasAnyMedia: hasAny, hasUsableMedia: hasUsable, reason });

    if (hasUsable) {
      await this.updatePitchRouting();
      this.applySpeedToAttachments();
    } else {
      this.disconnectPitchNode();
    }
  }

  private async updatePitchRouting(): Promise<void> {
    if (Math.abs(this.targetPitch) < 1e-4) {
      this.disconnectPitchNode();
      return;
    }
    await this.connectPitchNode();
    if (this.pitchNode && this.audioContext) {
      const param = this.pitchNode.parameters.get('pitch');
      if (param) {
        param.setValueAtTime(this.targetPitch, this.audioContext.currentTime);
      }
    }
  }

  async setTargets(pitchSemitones: number, speedPercent: number): Promise<void> {
    this.targetPitch = pitchSemitones;
    this.targetSpeed = speedPercent;
    this.applySpeedToAttachments();
    if (this.attachments.size > 0) {
      await this.updatePitchRouting();
    }
  }
}

