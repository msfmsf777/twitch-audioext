import { i18n } from '../shared/i18n';
import type { BackgroundToPopupMessage, PopupToBackgroundMessage } from '../shared/messages';
import {
  createDefaultPopupState,
  type BindingDefinition,
  type BindingEventType,
  type PopupPersistentState,
  type SubTier,
  type TestEventType,
  type ChannelPointRewardSummary,
  type MediaAvailabilityState
} from '../shared/state';
import type { EventLogEntry, EventLogAction } from '../shared/event-log';
import { createEmptyDiagnostics, type TwitchDiagnosticsSnapshot } from '../shared/twitch';

const appRoot = document.getElementById('app');

if (!appRoot) {
  throw new Error('Popup root element missing');
}

type PopupView = 'main' | 'bindingsList' | 'bindingEditor';

type BindingDraft = {
  id: string | null;
  label: string;
  eventType: BindingEventType | '';
  channelPointsRewardId: string | null;
  bitsMode: 'exact' | 'range';
  bitsExact: string;
  bitsMin: string;
  bitsMax: string;
  giftMode: 'exact' | 'range';
  giftExact: string;
  giftMin: string;
  giftMax: string;
  subTiers: SubTier[];
  action: 'pitch' | 'speed' | '';
  amount: string;
  delaySeconds: string;
  durationSeconds: string;
  chatTemplate: string;
  enabled: boolean;
};

class ToastManager {
  private container: HTMLElement;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    const target = parent.ownerDocument?.body ?? document.body;
    target.appendChild(this.container);
  }

  show(message: string): void {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    this.container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast--visible'));
    setTimeout(() => {
      toast.classList.remove('toast--visible');
      setTimeout(() => toast.remove(), 250);
    }, 2500);
  }
}

type ConfirmOptions = {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
};

class ConfirmDialog {
  private element: HTMLDivElement;
  private resolve?: (value: boolean) => void;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'confirm-overlay';
    this.element.innerHTML = `
      <div class="confirm-dialog">
        <p class="confirm-dialog__message"></p>
        <div class="confirm-dialog__actions">
          <button class="btn btn--link confirm-dialog__cancel"></button>
          <button class="btn btn--primary confirm-dialog__confirm"></button>
        </div>
      </div>
    `;
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) {
        this.resolve?.(false);
        this.hide();
      }
    });
    const target = parent.ownerDocument?.body ?? document.body;
    target.appendChild(this.element);
    this.hide();
  }

  async confirm(options: ConfirmOptions): Promise<boolean> {
    const messageEl = this.element.querySelector<HTMLParagraphElement>('.confirm-dialog__message');
    const cancelButton = this.element.querySelector<HTMLButtonElement>('.confirm-dialog__cancel');
    const confirmButton = this.element.querySelector<HTMLButtonElement>('.confirm-dialog__confirm');

    if (!messageEl || !cancelButton || !confirmButton) {
      return false;
    }

    messageEl.textContent = options.message;
    cancelButton.textContent = options.cancelLabel;
    confirmButton.textContent = options.confirmLabel;

    this.show();

    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
      cancelButton.onclick = () => {
        resolve(false);
        this.hide();
      };
      confirmButton.onclick = () => {
        resolve(true);
        this.hide();
      };
    });
  }

  private show(): void {
    this.element.classList.add('confirm-overlay--visible');
  }

  private hide(): void {
    this.element.classList.remove('confirm-overlay--visible');
  }
}

async function sendPopupMessage(message: PopupToBackgroundMessage): Promise<BackgroundToPopupMessage | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[popup] Message error', chrome.runtime.lastError.message);
          resolve(undefined);
          return;
        }
        resolve(response as BackgroundToPopupMessage | undefined);
      });
    } catch (error) {
      console.warn('[popup] Failed to send message', error);
      resolve(undefined);
    }
  });
}

class PopupApp {
  private state: PopupPersistentState = createDefaultPopupState();
  private view: PopupView = 'main';
  private bindingDraft: BindingDraft | null = null;
  private bindingDraftInitial: BindingDraft | null = null;
  private toast: ToastManager;
  private confirmDialog: ConfirmDialog;
  private languageMenuOpen = false;
  private editingValue: 'transpose' | 'speed' | null = null;
  private editingValueDraft = '';
  private editingValueInitial: number | null = null;
  private readonly twitchIconUrl = chrome.runtime.getURL('assets/icons/twitch.svg');
  private deleteConfirm: {
    id: string;
    button: HTMLButtonElement;
    timeoutId: number | null;
    outsideListener: (event: MouseEvent) => void;
  } | null = null;
  private diagnostics: TwitchDiagnosticsSnapshot = createEmptyDiagnostics();
  private channelRewards: ChannelPointRewardSummary[] = [];
  private eventLog: EventLogEntry[] = [];
  private eventLogUpdatedAt = 0;

  constructor(private readonly root: HTMLElement) {
    this.toast = new ToastManager(root);
    this.confirmDialog = new ConfirmDialog(root);
    chrome.runtime.onMessage.addListener((message) => {
      if (typeof message !== 'object' || message === null || !('type' in message)) {
        return;
      }
      this.handleBackgroundPush(message as BackgroundToPopupMessage);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') {
        return;
      }
      if ('channelRewards' in changes) {
        const next = (changes as any).channelRewards?.newValue as ChannelPointRewardSummary[] | undefined;
        if (Array.isArray(next) && !this.equalRewards(next)) {
          this.channelRewards = next;
          this.handleRewardSelectionChange();
          this.render();
        }
      }
      if ('eventLog' in changes) {
        const next = (changes as any).eventLog?.newValue as EventLogEntry[] | undefined;
        if (Array.isArray(next)) {
          this.eventLog = next;
          const updated = (changes as any).eventLogUpdatedAt?.newValue as number | undefined;
          if (typeof updated === 'number') {
            this.eventLogUpdatedAt = updated;
          }
          this.renderEventLogPanel();
        }
      }
      if ('eventLogUpdatedAt' in changes && !(changes as any).eventLog) {
        const updated = (changes as any).eventLogUpdatedAt?.newValue as number | undefined;
        if (typeof updated === 'number') {
          this.eventLogUpdatedAt = updated;
          this.renderEventLogPanel();
        }
      }
    });
  }

  async init(): Promise<void> {
    const initialState = await this.requestInitialState();
    this.state = initialState;
    await i18n.init(this.state.language);
    const activeLanguage = i18n.getActiveCode();
    if (activeLanguage !== this.state.language) {
      this.state = { ...this.state, language: activeLanguage };
      void this.persistState();
    }
    await this.loadSharedData();
    i18n.onChange((code) => {
      if (this.state.language !== code) {
        this.state = { ...this.state, language: code };
        void this.persistState();
        this.render();
      } else {
        this.render();
      }
    });
    this.render();
  }

  private async requestInitialState(): Promise<PopupPersistentState> {
    const response = await sendPopupMessage({ type: 'POPUP_READY' });
    if (response?.type === 'BACKGROUND_STATE') {
      return response.state;
    }
    return createDefaultPopupState();
  }

  private async loadSharedData(): Promise<void> {
    const data = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get(['channelRewards', 'eventLog', 'eventLogUpdatedAt'], (result) => {
        resolve(result);
      });
    });
    const rewards = data.channelRewards;
    if (Array.isArray(rewards)) {
      this.channelRewards = rewards as ChannelPointRewardSummary[];
    }
    const log = data.eventLog;
    if (Array.isArray(log)) {
      this.eventLog = log as EventLogEntry[];
    }
    const updated = data.eventLogUpdatedAt;
    if (typeof updated === 'number') {
      this.eventLogUpdatedAt = updated;
    }
    this.handleRewardSelectionChange();
  }

  private getMediaAvailability(): MediaAvailabilityState {
    const availability = this.state.mediaAvailability;
    if (!availability) {
      return { hasAnyMedia: true, hasUsableMedia: true, reason: 'none' };
    }
    return availability;
  }

  private controlsDisabled(): boolean {
    return !this.getMediaAvailability().hasUsableMedia;
  }

  private getMediaStatusMessage(): string | null {
    const availability = this.getMediaAvailability();
    if (!availability.hasAnyMedia) {
      return i18n.t('media.noMedia');
    }
    if (!availability.hasUsableMedia) {
      return availability.reason === 'drm_cors'
        ? i18n.t('media.unsupported')
        : i18n.t('media.noMedia');
    }
    return null;
  }

  private async persistState(): Promise<void> {
    const response = await sendPopupMessage({ type: 'POPUP_UPDATE_STATE', state: this.state });
    if (response?.type === 'BACKGROUND_STATE') {
      this.state = response.state;
    }
  }

  private equalRewards(next: ChannelPointRewardSummary[]): boolean {
    if (this.channelRewards.length !== next.length) {
      return false;
    }
    for (let index = 0; index < next.length; index += 1) {
      const current = this.channelRewards[index];
      const candidate = next[index];
      if (!current || current.id !== candidate.id) {
        return false;
      }
      if (current.title !== candidate.title) {
        return false;
      }
      const currentCost = current.cost ?? null;
      const candidateCost = candidate.cost ?? null;
      if (currentCost !== candidateCost) {
        return false;
      }
    }
    return true;
  }

  private handleRewardSelectionChange(): void {
    const availableIds = new Set(this.channelRewards.map((reward) => reward.id));
    if (this.state.testEvents.channelPointsRewardId && !availableIds.has(this.state.testEvents.channelPointsRewardId)) {
      const nextId = this.channelRewards[0]?.id ?? null;
      this.updateTestEvents({ channelPointsRewardId: nextId }, { rerender: false });
    }
    if (this.bindingDraft && this.bindingDraft.eventType === 'channel_points') {
      const current = this.bindingDraft.channelPointsRewardId;
      const hasCurrent = current ? availableIds.has(current) : false;
      if (!hasCurrent) {
        const fallback =
          !this.bindingDraft.id && this.channelRewards.length > 0 ? this.channelRewards[0]?.id ?? null : null;
        this.bindingDraft = { ...this.bindingDraft, channelPointsRewardId: fallback };
      }
    }
  }

  private renderEventLogPanel(): void {
    if (this.view !== 'main') {
      return;
    }
    const container = this.root.querySelector('.event-log');
    if (!container) {
      return;
    }
    container.outerHTML = this.renderEventLogBlock();
    this.bindEventLogControls();
  }

  private persistDiagnostics(expanded: boolean): void {
    this.state = { ...this.state, diagnosticsExpanded: expanded };
    void sendPopupMessage({ type: 'POPUP_TOGGLE_DEVTOOLS', expanded }).then((response) => {
      if (response?.type === 'BACKGROUND_DEVTOOLS') {
        this.state = { ...this.state, diagnosticsExpanded: response.expanded };
      }
    });
  }

  private handleBackgroundPush(message: BackgroundToPopupMessage): void {
    switch (message.type) {
      case 'BACKGROUND_STATE':
        this.state = message.state;
        this.render();
        break;
      case 'BACKGROUND_DEVTOOLS':
        this.state = { ...this.state, diagnosticsExpanded: message.expanded };
        this.render();
        break;
      case 'BACKGROUND_DIAGNOSTICS':
        this.diagnostics = message.diagnostics;
        this.updateDiagnosticsPanel();
        break;
      default:
        break;
    }
  }

  private updateDiagnosticsPanel(): void {
    const body = this.root.querySelector<HTMLDivElement>('.diagnostics__body');
    if (body) {
      body.innerHTML = this.renderDiagnosticsContent();
    }
  }

  private setView(view: PopupView): void {
    this.view = view;
    this.render();
  }

  private openBindingsList(): void {
    this.setView('bindingsList');
  }

  private openBindingEditor(bindingId: string | null): void {
    const existing = bindingId ? this.state.bindings.find((entry) => entry.id === bindingId) : null;
    const needsRewardPrompt =
      !!existing &&
      existing.config.type === 'channel_points' &&
      (!existing.config.rewardId || String(existing.config.rewardId).trim().length === 0);
    this.bindingDraft = this.createBindingDraft(bindingId);
    this.bindingDraftInitial = JSON.parse(JSON.stringify(this.bindingDraft));
    this.view = 'bindingEditor';
    this.render();
    if (needsRewardPrompt) {
      setTimeout(() => this.toast.show(i18n.t('bindings.reselectReward')), 0);
    }
  }

  private async maybeLeaveBindingEditor(): Promise<boolean> {
    if (!this.bindingDraft || !this.bindingDraftInitial) {
      return true;
    }
    if (JSON.stringify(this.bindingDraft) === JSON.stringify(this.bindingDraftInitial)) {
      return true;
    }
    const leave = await this.confirmDialog.confirm({
      message: i18n.t('bindings.unsavedConfirm'),
      confirmLabel: i18n.t('bindings.unsavedConfirmLeave'),
      cancelLabel: i18n.t('bindings.unsavedConfirmCancel')
    });
    return leave;
  }

  private createBindingDraft(bindingId: string | null): BindingDraft {
    if (bindingId) {
      const binding = this.state.bindings.find((entry) => entry.id === bindingId);
      if (binding) {
        return {
          id: binding.id,
          label: binding.label,
          eventType: binding.eventType,
          channelPointsRewardId:
            binding.config.type === 'channel_points' ? binding.config.rewardId ?? null : null,
          bitsMode: binding.config.type === 'bits' ? binding.config.range.mode : 'exact',
          bitsExact:
            binding.config.type === 'bits' && binding.config.range.exact !== null && binding.config.range.exact !== undefined
              ? String(binding.config.range.exact)
              : '',
          bitsMin:
            binding.config.type === 'bits' && binding.config.range.min !== null && binding.config.range.min !== undefined
              ? String(binding.config.range.min)
              : '',
          bitsMax:
            binding.config.type === 'bits' && binding.config.range.max !== null && binding.config.range.max !== undefined
              ? String(binding.config.range.max)
              : '',
          giftMode: binding.config.type === 'gift_sub' ? binding.config.range.mode : 'exact',
          giftExact:
            binding.config.type === 'gift_sub' && binding.config.range.exact !== null && binding.config.range.exact !== undefined
              ? String(binding.config.range.exact)
              : '',
          giftMin:
            binding.config.type === 'gift_sub' && binding.config.range.min !== null && binding.config.range.min !== undefined
              ? String(binding.config.range.min)
              : '',
          giftMax:
            binding.config.type === 'gift_sub' && binding.config.range.max !== null && binding.config.range.max !== undefined
              ? String(binding.config.range.max)
              : '',
          subTiers: binding.config.type === 'sub' ? [...binding.config.tiers] : ['tier1'],
          action: binding.action.type,
          amount: String(binding.action.amount),
          delaySeconds: binding.delaySeconds != null ? String(binding.delaySeconds) : '',
          durationSeconds: binding.durationSeconds != null ? String(binding.durationSeconds) : '',
          chatTemplate: binding.chatTemplate,
          enabled: binding.enabled
        };
      }
    }
    return {
      id: null,
      label: '',
      eventType: '',
      channelPointsRewardId: null,
      bitsMode: 'exact',
      bitsExact: '',
      bitsMin: '',
      bitsMax: '',
      giftMode: 'exact',
      giftExact: '',
      giftMin: '',
      giftMax: '',
      subTiers: ['tier1'],
      action: '',
      amount: '',
      delaySeconds: '',
      durationSeconds: '',
      chatTemplate: '',
      enabled: true
    };
  }

  private bindingDraftIsValid(): boolean {
    if (!this.bindingDraft) return false;
    if (!this.bindingDraft.label.trim()) return false;
    if (!this.bindingDraft.eventType) return false;
    if (this.bindingDraft.eventType === 'channel_points') {
      const rewardId = this.bindingDraft.channelPointsRewardId;
      if (!rewardId) {
        return false;
      }
      if (rewardId.trim() === '') {
        return false;
      }
    }
    if (!this.bindingDraft.action) return false;
    if (!this.bindingDraft.amount.trim()) return false;
    const amount = Number.parseFloat(this.bindingDraft.amount);
    if (!Number.isFinite(amount)) return false;
    return true;
  }

  private commitBindingDraft(): void {
    if (!this.bindingDraft) return;
    const draft = this.bindingDraft;
    const binding: BindingDefinition = {
      id: draft.id ?? crypto.randomUUID(),
      label: draft.label.trim(),
      enabled: draft.enabled,
      eventType: draft.eventType as BindingEventType,
      config: this.deriveBindingConfig(draft),
      action: {
        type: draft.action as 'pitch' | 'speed',
        amount: Number.parseFloat(draft.amount)
      },
      delaySeconds: draft.delaySeconds ? Number.parseFloat(draft.delaySeconds) : null,
      durationSeconds: draft.durationSeconds ? Number.parseFloat(draft.durationSeconds) : null,
      chatTemplate: draft.chatTemplate
    };

    const existingIndex = this.state.bindings.findIndex((entry) => entry.id === binding.id);
    let bindings: BindingDefinition[];
    if (existingIndex >= 0) {
      bindings = [...this.state.bindings];
      bindings[existingIndex] = binding;
    } else {
      bindings = [...this.state.bindings, binding];
    }
    this.state = { ...this.state, bindings };
    void this.persistState();
    this.toast.show(i18n.t('toasts.bindingSaved'));
    this.openBindingsList();
  }

  private deriveBindingConfig(draft: BindingDraft): BindingDefinition['config'] {
    switch (draft.eventType) {
      case 'channel_points':
        if (!draft.channelPointsRewardId) {
          return { type: 'channel_points', rewardId: null, rewardTitle: null };
        }
        {
          const reward = this.channelRewards.find((item) => item.id === draft.channelPointsRewardId);
          let rewardTitle: string | null = reward?.title ?? null;
          if (!rewardTitle && draft.id) {
            const previous = this.state.bindings.find((entry) => entry.id === draft.id);
            if (previous && previous.config.type === 'channel_points') {
              rewardTitle = previous.config.rewardTitle ?? previous.config.rewardId ?? null;
            }
          }
          return {
            type: 'channel_points',
            rewardId: draft.channelPointsRewardId,
            rewardTitle
          };
        }
      case 'bits':
        return {
          type: 'bits',
          range: {
            mode: draft.bitsMode,
            exact: draft.bitsMode === 'exact' && draft.bitsExact ? Number.parseFloat(draft.bitsExact) : null,
            min: draft.bitsMode === 'range' && draft.bitsMin ? Number.parseFloat(draft.bitsMin) : null,
            max: draft.bitsMode === 'range' && draft.bitsMax ? Number.parseFloat(draft.bitsMax) : null
          }
        };
      case 'gift_sub':
        return {
          type: 'gift_sub',
          range: {
            mode: draft.giftMode,
            exact: draft.giftMode === 'exact' && draft.giftExact ? Number.parseFloat(draft.giftExact) : null,
            min: draft.giftMode === 'range' && draft.giftMin ? Number.parseFloat(draft.giftMin) : null,
            max: draft.giftMode === 'range' && draft.giftMax ? Number.parseFloat(draft.giftMax) : null
          }
        };
      case 'sub':
        return { type: 'sub', tiers: [...new Set(draft.subTiers)] };
      case 'follow':
      default:
        return { type: 'follow' };
    }
  }

  private setDeleteConfirm(button: HTMLButtonElement, id: string): void {
    this.clearDeleteConfirm();
    button.textContent = i18n.t('bindings.deleteConfirm');
    button.classList.add('binding-row__delete--confirm');
    button.setAttribute('data-confirming', 'true');
    const doc = this.root.ownerDocument ?? document;
    const outsideListener = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target === button) {
        return;
      }
      if (target.closest(`[data-action="delete-binding"][data-binding-id="${id}"]`)) {
        return;
      }
      this.clearDeleteConfirm();
    };
    const timeoutId = window.setTimeout(() => this.clearDeleteConfirm(), 3000);
    this.deleteConfirm = { id, button, timeoutId, outsideListener };
    window.setTimeout(() => {
      if (this.deleteConfirm?.id === id) {
        doc.addEventListener('click', outsideListener);
      }
    }, 0);
  }

  private clearDeleteConfirm(): void {
    if (!this.deleteConfirm) {
      return;
    }
    const { button, timeoutId, outsideListener } = this.deleteConfirm;
    const doc = this.root.ownerDocument ?? document;
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    doc.removeEventListener('click', outsideListener);
    if (button.isConnected) {
      button.textContent = i18n.t('bindings.delete');
      button.classList.remove('binding-row__delete--confirm');
      button.removeAttribute('data-confirming');
    }
    this.deleteConfirm = null;
  }

  private deleteBinding(id: string): void {
    this.clearDeleteConfirm();
    const bindings = this.state.bindings.filter((entry) => entry.id !== id);
    this.state = { ...this.state, bindings };
    void this.persistState();
    this.toast.show(i18n.t('toasts.bindingDeleted'));
    this.render();
  }

  private toggleBinding(id: string, enabled: boolean): void {
    this.clearDeleteConfirm();
    const bindings = this.state.bindings.map((entry) => (entry.id === id ? { ...entry, enabled } : entry));
    this.state = { ...this.state, bindings };
    void this.persistState();
    this.render();
  }

  private updateTestEvents(
    update: Partial<PopupPersistentState['testEvents']>,
    options: { rerender?: boolean } = {}
  ): void {
    this.state = { ...this.state, testEvents: { ...this.state.testEvents, ...update } };
    if (options.rerender) {
      this.render();
    }
    void this.persistState();
  }

  private formatSemitoneValue(): string {
    const value = this.state.semitoneOffset + this.state.effectSemitoneOffset;
    if (value > 0) {
      return `+${value}`;
    }
    if (value < 0) {
      return `-${Math.abs(value)}`;
    }
    return '0';
  }

  private formatSpeedValue(): string {
    const value = this.state.speedPercent + this.state.effectSpeedPercent;
    return `${value}%`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private getTwitchConnectionState(): {
    status: string;
    button: string;
    tone: 'connected' | 'warning' | 'disconnected';
    connected: boolean;
  } {
    if (this.state.loggedIn) {
      return {
        status: i18n.t('twitch.statusConnected', { displayName: this.state.twitchDisplayName ?? '—' }),
        button: i18n.t('twitch.disconnect'),
        tone: 'connected',
        connected: true
      };
    }
    if (this.state.twitchDisplayName) {
      return {
        status: i18n.t('twitch.statusReconnect'),
        button: i18n.t('twitch.reconnect'),
        tone: 'warning',
        connected: false
      };
    }
    return {
      status: i18n.t('twitch.statusDisconnected'),
      button: i18n.t('twitch.connect'),
      tone: 'disconnected',
      connected: false
    };
  }

  private testEventNeedsAmount(type: TestEventType): boolean {
    return type === 'bits' || type === 'gift_sub';
  }

  private testEventNeedsReward(type: TestEventType): boolean {
    return type === 'channel_points';
  }

  private testEventNeedsTier(type: TestEventType): boolean {
    return type === 'sub';
  }

  private adjustSemitone(delta: number): void {
    if (this.controlsDisabled()) {
      return;
    }
    this.setSemitone(this.state.semitoneOffset + delta);
  }

  private setSemitone(
    value: number,
    options: { render?: boolean; persist?: boolean; forcePersist?: boolean; forceRender?: boolean } = {}
  ): void {
    const bounded = Math.max(-12, Math.min(12, Math.round(value)));
    const changed = this.state.semitoneOffset !== bounded;
    if (changed) {
      this.state = { ...this.state, semitoneOffset: bounded };
    }
    if (options.render === false) {
      this.syncControlDisplays();
    } else if (changed || options.forceRender) {
      this.render();
    }
    if ((changed && options.persist !== false) || options.forcePersist) {
      void this.persistState();
    }
  }

  private adjustSpeed(delta: number): void {
    if (this.controlsDisabled()) {
      return;
    }
    this.setSpeed(this.state.speedPercent + delta);
  }

  private setSpeed(
    value: number,
    options: { render?: boolean; persist?: boolean; forcePersist?: boolean; forceRender?: boolean } = {}
  ): void {
    const bounded = Math.max(50, Math.min(200, Math.round(value)));
    const changed = this.state.speedPercent !== bounded;
    if (changed) {
      this.state = { ...this.state, speedPercent: bounded };
    }
    if (options.render === false) {
      this.syncControlDisplays();
    } else if (changed || options.forceRender) {
      this.render();
    }
    if ((changed && options.persist !== false) || options.forcePersist) {
      void this.persistState();
    }
  }

  private resetTranspose(): void {
    if (this.controlsDisabled()) {
      return;
    }
    this.setSemitone(0);
  }

  private resetSpeed(): void {
    if (this.controlsDisabled()) {
      return;
    }
    this.setSpeed(100);
  }

  private syncControlDisplays(): void {
    const transposeSlider = this.root.querySelector<HTMLInputElement>('[data-role="transpose-slider"]');
    if (transposeSlider) {
      const value = String(this.state.semitoneOffset);
      if (transposeSlider.value !== value) {
        transposeSlider.value = value;
      }
    }
    if (this.editingValue !== 'transpose') {
      const transposeValue = this.root.querySelector<HTMLElement>('[data-role="transpose-value-display"]');
      if (transposeValue) {
        transposeValue.textContent = this.formatSemitoneValue();
      }
    }

    const speedSlider = this.root.querySelector<HTMLInputElement>('[data-role="speed-slider"]');
    if (speedSlider) {
      const value = String(this.state.speedPercent);
      if (speedSlider.value !== value) {
        speedSlider.value = value;
      }
    }
    if (this.editingValue !== 'speed') {
      const speedValue = this.root.querySelector<HTMLElement>('[data-role="speed-value-display"]');
      if (speedValue) {
        speedValue.textContent = this.formatSpeedValue();
      }
    }
  }

  private beginValueEdit(control: 'transpose' | 'speed'): void {
    if (this.controlsDisabled()) {
      return;
    }
    if (this.editingValue === control) {
      return;
    }
    this.editingValue = control;
    const current = control === 'transpose' ? this.state.semitoneOffset : this.state.speedPercent;
    this.editingValueDraft = String(current);
    this.editingValueInitial = current;
    this.render();
  }

  private commitValueEdit(control: 'transpose' | 'speed'): void {
    if (this.controlsDisabled()) {
      this.cancelValueEdit(control);
      return;
    }
    const selector = control === 'transpose' ? '[data-role="transpose-value-input"]' : '[data-role="speed-value-input"]';
    const input = this.root.querySelector<HTMLInputElement>(selector);
    if (!input) {
      return;
    }

    const raw = input.value.trim();
    const bounds = control === 'transpose' ? { min: -12, max: 12 } : { min: 50, max: 200 };
    const fallback = this.editingValueInitial ?? (control === 'transpose' ? 0 : 100);
    const messageKey = control === 'transpose' ? 'transpose.invalidValue' : 'speed.invalidValue';
    const restore = () => {
      this.toast.show(i18n.t(messageKey));
      const restored = String(fallback);
      this.editingValueDraft = restored;
      requestAnimationFrame(() => {
        input.value = restored;
        input.focus();
        input.select();
      });
    };

    const pattern = control === 'transpose' ? /^[+-]?\d+$/ : /^[+]?\d+$/;
    if (!pattern.test(raw)) {
      restore();
      return;
    }

    const parsed = Number.parseInt(raw, 10);

    if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < bounds.min || parsed > bounds.max) {
      restore();
      return;
    }

    this.editingValue = null;
    this.editingValueDraft = '';
    this.editingValueInitial = null;

    if (control === 'transpose') {
      this.setSemitone(parsed);
    } else {
      this.setSpeed(parsed);
    }
  }

  private cancelValueEdit(control: 'transpose' | 'speed'): void {
    this.editingValue = null;
    this.editingValueDraft = '';
    this.editingValueInitial = null;
    this.render();
  }

  private focusEditingInput(): void {
    if (!this.editingValue) {
      return;
    }
    const selector = this.editingValue === 'transpose' ? '[data-role="transpose-value-input"]' : '[data-role="speed-value-input"]';
    const input = this.root.querySelector<HTMLInputElement>(selector);
    if (input) {
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    }
  }

  private toggleCapture(enabled: boolean): void {
    this.state = { ...this.state, captureEvents: enabled };
    this.render();
    void this.persistState();
  }

  private toggleLanguageMenu(): void {
    this.languageMenuOpen = !this.languageMenuOpen;
    this.render();
  }

  private selectLanguage(code: string): void {
    this.languageMenuOpen = false;
    i18n.setActiveCode(code);
  }

  private async runAction(message: PopupToBackgroundMessage): Promise<void> {
    const response = await sendPopupMessage(message);
    if (!response) {
      return;
    }
    if (response.type === 'BACKGROUND_ACTION_RESULT') {
      if (response.state) {
        this.state = response.state;
        this.render();
      }
      if (response.messageKey) {
        this.toast.show(i18n.t(response.messageKey, response.messageParams ?? {}));
      }
    } else if (response.type === 'BACKGROUND_STATE') {
      this.state = response.state;
      this.render();
    }
  }

  private async handleTwitchButton(): Promise<void> {
    const meta = this.getTwitchConnectionState();
    if (meta.connected) {
      await this.runAction({ type: 'POPUP_TWITCH_DISCONNECT' });
    } else if (this.state.twitchDisplayName) {
      await this.runAction({ type: 'POPUP_TWITCH_RECONNECT' });
    } else {
      await this.runAction({ type: 'POPUP_TWITCH_CONNECT' });
    }
  }

  private toggleCaptureEvents(enabled: boolean): void {
    this.toggleCapture(enabled);
  }

  private toggleDiagnostics(): void {
    this.persistDiagnostics(!this.state.diagnosticsExpanded);
    this.render();
  }

  private toggleEventLog(): void {
    this.state = { ...this.state, eventLogExpanded: !this.state.eventLogExpanded };
    void this.persistState();
    this.renderEventLogPanel();
  }

  private async handleRefreshRewards(): Promise<void> {
    await this.runAction({ type: 'POPUP_REFRESH_REWARDS' });
  }

  private async handleFireTest(): Promise<void> {
    if (!this.state.loggedIn) {
      return;
    }

    const { testEvents } = this.state;
    const name = testEvents.username.trim();
    const errors: string[] = [];

    if (!name) {
      errors.push('username');
    }

    let amountValue: number | null = null;
    if (this.testEventNeedsAmount(testEvents.type)) {
      if (!testEvents.amount.trim()) {
        errors.push('amount');
      } else {
        const parsed = Number.parseFloat(testEvents.amount);
        if (!Number.isFinite(parsed) || parsed < 0) {
          errors.push('amount');
        } else {
          amountValue = parsed;
        }
      }
    }

    if (this.testEventNeedsReward(testEvents.type) && !testEvents.channelPointsRewardId) {
      errors.push('reward');
    }

    if (errors.length > 0) {
      this.toast.show(i18n.t('toasts.testInvalid'));
      return;
    }

    const payload = {
      type: testEvents.type,
      username: name,
      amount: amountValue,
      rewardId: testEvents.channelPointsRewardId,
      subTier: testEvents.subTier
    };
    await this.runAction({ type: 'POPUP_TRIGGER_TEST_EVENT', payload });
  }

  private insertUserTemplate(): void {
    if (!this.bindingDraft) return;
    const selection = '%user%';
    const el = this.root.querySelector<HTMLTextAreaElement>('textarea[name="chatTemplate"]');
    if (el) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const newValue = `${el.value.slice(0, start)}${selection}${el.value.slice(end)}`;
      el.value = newValue;
      el.setSelectionRange(start + selection.length, start + selection.length);
      this.updateBindingDraft({ chatTemplate: newValue });
    }
  }
  private updateBindingDraft(update: Partial<BindingDraft>, options: { rerender?: boolean } = {}): void {
    if (!this.bindingDraft) return;
    this.bindingDraft = { ...this.bindingDraft, ...update };
    if (options.rerender) {
      this.render();
    } else {
      this.refreshBindingEditorSaveState();
    }
  }

  private updateBindingDraftTier(tier: SubTier, checked: boolean): void {
    if (!this.bindingDraft) return;
    const tiers = new Set(this.bindingDraft.subTiers);
    if (checked) tiers.add(tier);
    else tiers.delete(tier);
    this.bindingDraft = { ...this.bindingDraft, subTiers: Array.from(tiers) };
    this.refreshBindingEditorSaveState();
  }

  private refreshBindingEditorSaveState(): void {
    if (this.view !== 'bindingEditor') return;
    const saveButton = this.root.querySelector<HTMLButtonElement>('[data-action="save-binding"]');
    if (saveButton) {
      saveButton.disabled = !this.bindingDraftIsValid();
    }
    const amountInput = this.root.querySelector<HTMLInputElement>('input[name="amount"]');
    if (amountInput) {
      let hint = '';
      if (this.bindingDraft?.action === 'pitch') {
        hint = i18n.t('bindings.amountHintPitch');
      } else if (this.bindingDraft?.action === 'speed') {
        hint = i18n.t('bindings.amountHintSpeed');
      }
      if (hint) {
        amountInput.placeholder = hint;
      } else {
        amountInput.removeAttribute('placeholder');
      }
    }
  }

  private buildMainView(): string {
    const languageOptions = i18n
      .getAvailableLocales()
      .map(
        (entry) => `
          <button class="menu-item" data-lang-code="${entry.code}">
            ${entry.name}
          </button>
        `
      )
      .join('');

    const connection = this.getTwitchConnectionState();

    return `
      <div class="popup">
        <header class="popup__header">
          <h1 class="popup__title">${i18n.t('app.title')}</h1>
          <div class="popup__header-actions">
            <button class="icon-button" data-action="toggle-language" aria-label="${i18n.t('misc.language')}">🌐</button>
            <div class="language-menu ${this.languageMenuOpen ? 'language-menu--open' : ''}">
              ${languageOptions}
            </div>
          </div>
        </header>
        <main class="popup__content">
          ${this.renderTransposeBlock()}
          ${this.renderSpeedBlock()}
          ${this.renderTwitchSection()}
          ${this.renderBindingsEntry(connection.connected)}
          ${this.renderTestEventsBlock()}
          ${this.renderEventLogBlock()}
        </main>
        ${this.renderDiagnosticsPanel()}
      </div>
    `;
  }

  private renderTransposeBlock(): string {
    const disabled = this.controlsDisabled();
    const isEditing = !disabled && this.editingValue === 'transpose';
    const currentValue = isEditing ? this.editingValueDraft : this.formatSemitoneValue();
    const message = this.getMediaStatusMessage();
    const messageHtml = message
      ? `<p class="control-block__status" role="status" aria-live="polite">${message}</p>`
      : '';
    return `
      <section class="control-block ${disabled ? 'control-block--disabled' : ''}" aria-labelledby="transpose-heading" aria-disabled="${disabled}">
        <div class="control-block__row control-block__row--top">
          <div class="control-block__title-group">
            <h2 id="transpose-heading" class="control-block__title">${i18n.t('transpose.title')}</h2>
            ${messageHtml}
          </div>
          ${
            isEditing
              ? `<input
                  type="number"
                  class="control-block__value control-block__value-input"
                  data-role="transpose-value-input"
                  value="${currentValue}"
                  min="-12"
                  max="12"
                  step="1"
                  aria-label="${i18n.t('transpose.valueInputLabel')}"
                  aria-live="polite"
                />`
              : `<button
                  type="button"
                  class="control-block__value control-block__value-button"
                  data-action="transpose-begin-edit"
                  data-role="transpose-value-display"
                  aria-label="${i18n.t('transpose.valueButtonLabel')}"
                  aria-live="polite"
                  ${disabled ? 'disabled' : ''}
                >${currentValue}</button>`
          }
          <button type="button" class="btn btn--ghost control-block__reset" data-action="transpose-reset" ${disabled ? 'disabled' : ''}>
            ${i18n.t('transpose.reset')}
          </button>
        </div>
        <div class="control-block__row control-block__row--controls">
          <button
            type="button"
            class="stepper"
            data-action="transpose-decrement"
            aria-label="${i18n.t('transpose.decrementLabel')}"
            ${disabled ? 'disabled' : ''}
          >
            −
          </button>
          <input
            type="range"
            min="-12"
            max="12"
            step="1"
            value="${this.state.semitoneOffset}"
            data-role="transpose-slider"
            aria-labelledby="transpose-heading"
            ${disabled ? 'disabled' : ''}
          />
          <button
            type="button"
            class="stepper"
            data-action="transpose-increment"
            aria-label="${i18n.t('transpose.incrementLabel')}"
            ${disabled ? 'disabled' : ''}
          >
            +
          </button>
        </div>
      </section>
    `;
  }

  private renderSpeedBlock(): string {
    const disabled = this.controlsDisabled();
    const isEditing = !disabled && this.editingValue === 'speed';
    const currentValue = isEditing ? this.editingValueDraft : this.formatSpeedValue();
    const message = this.getMediaStatusMessage();
    const messageHtml = message
      ? `<p class="control-block__status" role="status" aria-live="polite">${message}</p>`
      : '';
    return `
      <section class="control-block ${disabled ? 'control-block--disabled' : ''}" aria-labelledby="speed-heading" aria-disabled="${disabled}">
        <div class="control-block__row control-block__row--top">
          <div class="control-block__title-group">
            <h2 id="speed-heading" class="control-block__title">${i18n.t('speed.title')}</h2>
            ${messageHtml}
          </div>
          ${
            isEditing
              ? `<input
                  type="number"
                  class="control-block__value control-block__value-input"
                  data-role="speed-value-input"
                  value="${currentValue}"
                  min="50"
                  max="200"
                  step="1"
                  aria-label="${i18n.t('speed.valueInputLabel')}"
                  aria-live="polite"
                />`
              : `<button
                  type="button"
                  class="control-block__value control-block__value-button"
                  data-action="speed-begin-edit"
                  data-role="speed-value-display"
                  aria-label="${i18n.t('speed.valueButtonLabel')}"
                  aria-live="polite"
                  ${disabled ? 'disabled' : ''}
                >${currentValue}</button>`
          }
          <button type="button" class="btn btn--ghost control-block__reset" data-action="speed-reset" ${disabled ? 'disabled' : ''}>
            ${i18n.t('speed.reset')}
          </button>
        </div>
        <div class="control-block__row control-block__row--controls">
          <button
            type="button"
            class="stepper"
            data-action="speed-decrement"
            aria-label="${i18n.t('speed.decrementLabel')}"
            ${disabled ? 'disabled' : ''}
          >
            −
          </button>
          <input
            type="range"
            min="50"
            max="200"
            step="1"
            value="${this.state.speedPercent}"
            data-role="speed-slider"
            aria-labelledby="speed-heading"
            ${disabled ? 'disabled' : ''}
          />
          <button
            type="button"
            class="stepper"
            data-action="speed-increment"
            aria-label="${i18n.t('speed.incrementLabel')}"
            ${disabled ? 'disabled' : ''}
          >
            +
          </button>
        </div>
      </section>
    `;
  }

  private renderTwitchSection(): string {
    const meta = this.getTwitchConnectionState();
    const iconUrl = this.twitchIconUrl;
    return `
      <section class="twitch-card" aria-label="${i18n.t('twitch.sectionLabel')}">
        <div class="twitch-card__row">
          <div class="twitch-card__identity">
            <span class="twitch-card__logo twitch-card__logo--${meta.tone}">
              <img src="${iconUrl}" alt="${i18n.t('twitch.logoAlt')}" width="24" height="24" />
            </span>
            <span class="twitch-card__status">${meta.status}</span>
          </div>
          <button type="button" class="btn btn--primary" data-action="twitch-button">${meta.button}</button>
        </div>
        <div class="twitch-card__row twitch-card__row--secondary">
          <div class="twitch-card__capture">
            <label class="toggle" data-role="capture-toggle-wrapper">
              <input type="checkbox" data-role="capture-toggle" ${this.state.captureEvents ? 'checked' : ''} />
              <span class="toggle__label">${i18n.t('twitch.captureToggle')}</span>
            </label>
            <button
              type="button"
              class="info-icon"
              title="${i18n.t('twitch.captureTooltip')}"
              aria-label="${i18n.t('twitch.captureTooltip')}"
              data-role="capture-tooltip"
            >
              ?
            </button>
          </div>
          <button
            type="button"
            class="btn btn--ghost twitch-card__refresh"
            data-action="refresh-rewards"
            ${this.state.loggedIn ? '' : 'disabled'}
          >
            ${i18n.t('twitch.refresh')}
          </button>
        </div>
      </section>
    `;
  }

  private renderTestEventsBlock(): string {
    if (!this.state.loggedIn) {
      return `
        <section class="test-events test-events--placeholder" aria-label="${i18n.t('testEvents.title')}">
          <div class="test-events__header">
            <h2 class="test-events__title">${i18n.t('testEvents.title')}</h2>
            <span class="test-events__hint">${i18n.t('testEvents.requiresLogin')}</span>
          </div>
        </section>
      `;
    }

    const { testEvents } = this.state;
    const needsAmount = this.testEventNeedsAmount(testEvents.type);
    const needsReward = this.testEventNeedsReward(testEvents.type);
    const needsTier = this.testEventNeedsTier(testEvents.type);

    const amountPlaceholder =
      testEvents.type === 'bits'
        ? i18n.t('testEvents.amountBitsPlaceholder')
        : i18n.t('testEvents.amountGiftPlaceholder');

    const rewardOptions = this.channelRewards
      .map((reward) => {
        const label = reward.cost != null ? `${reward.title} (${reward.cost})` : reward.title;
        const selected = testEvents.channelPointsRewardId === reward.id ? 'selected' : '';
        return `<option value="${reward.id}" ${selected}>${label}</option>`;
      })
      .join('');
    const rewardDisabled = this.channelRewards.length === 0 ? 'disabled' : '';
    const rewardField = needsReward
      ? `
          <label class="field field--compact">
            <span>${i18n.t('testEvents.reward')}</span>
            <select name="test-event-reward" ${rewardDisabled}>
              <option value="">${i18n.t('testEvents.rewardPlaceholder')}</option>
              ${rewardOptions}
            </select>
          </label>
        `
      : '';

    const amountField = needsAmount
      ? `
          <label class="field field--compact">
            <span>${i18n.t('testEvents.amount')}</span>
            <input
              type="number"
              name="test-event-amount"
              value="${testEvents.amount}"
              min="0"
              placeholder="${amountPlaceholder}"
            />
          </label>
        `
      : '';

    const tierField = needsTier
      ? `
          <label class="field field--compact">
            <span>${i18n.t('testEvents.subTier')}</span>
            <select name="test-event-tier">
              <option value="tier1" ${testEvents.subTier === 'tier1' ? 'selected' : ''}>${i18n.t('bindings.subTier1')}</option>
              <option value="tier2" ${testEvents.subTier === 'tier2' ? 'selected' : ''}>${i18n.t('bindings.subTier2')}</option>
              <option value="tier3" ${testEvents.subTier === 'tier3' ? 'selected' : ''}>${i18n.t('bindings.subTier3')}</option>
            </select>
          </label>
        `
      : '';

    return `
      <section class="test-events" aria-label="${i18n.t('testEvents.title')}">
        <div class="test-events__header">
          <h2 class="test-events__title">${i18n.t('testEvents.title')}</h2>
        </div>
        <form class="test-events__form" data-role="test-events-form">
          <label class="field field--compact">
            <span>${i18n.t('testEvents.eventType')}</span>
            <select name="test-event-type">
              <option value="channel_points" ${testEvents.type === 'channel_points' ? 'selected' : ''}>${i18n.t('bindings.channelPoints')}</option>
              <option value="bits" ${testEvents.type === 'bits' ? 'selected' : ''}>${i18n.t('bindings.bits')}</option>
              <option value="gift_sub" ${testEvents.type === 'gift_sub' ? 'selected' : ''}>${i18n.t('bindings.giftSub')}</option>
              <option value="sub" ${testEvents.type === 'sub' ? 'selected' : ''}>${i18n.t('bindings.sub')}</option>
              <option value="follow" ${testEvents.type === 'follow' ? 'selected' : ''}>${i18n.t('bindings.follow')}</option>
            </select>
          </label>
          <label class="field field--compact">
            <span>${i18n.t('testEvents.username')}</span>
            <input
              type="text"
              name="test-event-username"
              value="${testEvents.username}"
              placeholder="${i18n.t('testEvents.usernamePlaceholder')}"
            />
          </label>
          ${rewardField}
          ${amountField}
          ${tierField}
          <div class="test-events__action">
            <button type="submit" class="btn btn--primary" data-action="fire-test">${i18n.t('testEvents.fire')}</button>
          </div>
        </form>
      </section>
    `;
  }

  private renderEventLogBlock(): string {
    const count = this.eventLog.length;
    const lastTime = this.eventLogUpdatedAt || (this.eventLog[0]?.ts ?? null);
    const summary = i18n.t('eventLog.summary', {
      count,
      time: this.formatRelativeTime(lastTime)
    });
    const toggle = `
      <button class="event-log__toggle" data-action="toggle-event-log">
        ${summary}
      </button>
    `;
    if (!this.state.eventLogExpanded) {
      return `
        <section class="event-log" aria-label="${i18n.t('eventLog.title')}">
          ${toggle}
        </section>
      `;
    }
    const entries = count
      ? this.eventLog.map((entry) => this.renderEventLogEntry(entry)).join('')
      : `<p class="event-log__empty">${i18n.t('eventLog.empty')}</p>`;
    return `
      <section class="event-log event-log--open" aria-label="${i18n.t('eventLog.title')}">
        ${toggle}
        <div class="event-log__body">
          ${entries}
        </div>
      </section>
    `;
  }

  private renderEventLogEntry(entry: EventLogEntry): string {
    const summary = this.getEventSummary(entry);
    const statusLabel = this.getEventStatusLabel(entry.status);
    const statusClass = `event-log__status event-log__status--${entry.status}`;
    const relative = this.formatRelativeTime(entry.ts);
    const bindings = entry.matchedBindings.length
      ? entry.matchedBindings.map((binding) => this.escapeHtml(binding.label)).join(', ')
      : i18n.t('eventLog.none');
    const actions = this.formatEventActions(entry.actions);
    const delay = entry.delaySec != null ? `<li>${i18n.t('eventLog.delay', { seconds: entry.delaySec })}</li>` : '';
    const duration = entry.durationSec != null ? `<li>${i18n.t('eventLog.duration', { seconds: entry.durationSec })}</li>` : '';
    const note = entry.note ? `<li>${this.escapeHtml(entry.note)}</li>` : '';
    return `
      <details class="event-log__entry">
        <summary>
          <span class="event-log__summary-main">${summary}</span>
          <span class="${statusClass}">${statusLabel}</span>
          <span class="event-log__time">${relative}</span>
        </summary>
        <div class="event-log__details">
          <ul>
            <li>${i18n.t('eventLog.bindings')}: ${bindings}</li>
            <li>${i18n.t('eventLog.actions')}: ${actions || i18n.t('eventLog.none')}</li>
            ${delay}
            ${duration}
            ${note}
          </ul>
        </div>
      </details>
    `;
  }

  private getEventSummary(entry: EventLogEntry): string {
    const type = this.getEventTypeLabel(entry.eventType);
    const user = entry.userDisplay ? this.escapeHtml(entry.userDisplay) : i18n.t('eventLog.unknownUser');
    const detail = this.getEventDetail(entry);
    return `${type} — ${user}${detail ? ` • ${detail}` : ''}`;
  }

  private getEventDetail(entry: EventLogEntry): string | null {
    switch (entry.eventType) {
      case 'channel_points':
        if (entry.reward) {
          const title = this.escapeHtml(entry.reward.title);
          return entry.reward.cost != null ? `${title} (${entry.reward.cost})` : title;
        }
        return null;
      case 'cheer':
        if (entry.bitsAmount != null) {
          return i18n.t('eventLog.bitsAmount', { amount: entry.bitsAmount });
        }
        return null;
      case 'sub':
        if (entry.subTier) {
          return i18n.t('eventLog.subTier', { tier: this.formatSubTier(entry.subTier) });
        }
        return null;
      case 'gift_sub':
        if (entry.giftAmount != null) {
          return i18n.t('eventLog.giftAmount', { amount: entry.giftAmount });
        }
        return null;
      default:
        return null;
    }
  }

  private getEventTypeLabel(type: EventLogEntry['eventType']): string {
    switch (type) {
      case 'channel_points':
        return i18n.t('eventLog.typeChannelPoints');
      case 'cheer':
        return i18n.t('eventLog.typeCheer');
      case 'sub':
        return i18n.t('eventLog.typeSub');
      case 'gift_sub':
        return i18n.t('eventLog.typeGiftSub');
      case 'follow':
        return i18n.t('eventLog.typeFollow');
      default:
        return type;
    }
  }

  private getEventStatusLabel(status: EventLogEntry['status']): string {
    switch (status) {
      case 'queued':
        return i18n.t('eventLog.statusQueued');
      case 'applied':
        return i18n.t('eventLog.statusApplied');
      case 'reverted':
        return i18n.t('eventLog.statusReverted');
      case 'skipped':
        return i18n.t('eventLog.statusSkipped');
      case 'error':
        return i18n.t('eventLog.statusError');
      default:
        return status;
    }
  }

  private formatEventActions(actions: EventLogAction[]): string {
    const parts = actions.map((action) => {
      switch (action.kind) {
        case 'pitch':
          return i18n.t('eventLog.actionPitch', { amount: action.semitones });
        case 'speed':
          return i18n.t('eventLog.actionSpeed', { amount: action.percent });
        case 'chat': {
          if (action.error) {
            return i18n.t('eventLog.actionChatError');
          }
          if (action.sent) {
            return i18n.t('eventLog.actionChatSent');
          }
          return i18n.t('eventLog.actionChatQueued');
        }
        default:
          return '';
      }
    });
    return parts.filter(Boolean).join(', ');
  }

  private formatSubTier(tier: '1000' | '2000' | '3000'): string {
    switch (tier) {
      case '2000':
        return i18n.t('bindings.subTier2');
      case '3000':
        return i18n.t('bindings.subTier3');
      default:
        return i18n.t('bindings.subTier1');
    }
  }

  private formatRelativeTime(timestamp: number | null): string {
    if (!timestamp) {
      return i18n.t('eventLog.never');
    }
    const diff = Date.now() - timestamp;
    if (diff < 1000) {
      return i18n.t('eventLog.justNow');
    }
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) {
      return i18n.t('eventLog.secondsAgo', { seconds });
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return i18n.t('eventLog.minutesAgo', { minutes });
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return i18n.t('eventLog.hoursAgo', { hours });
    }
    const days = Math.floor(hours / 24);
    return i18n.t('eventLog.daysAgo', { days });
  }
  private renderBindingsEntry(connected: boolean): string {
    const disabled = !connected;
    return `
      <button
        class="bindings-entry ${disabled ? 'bindings-entry--disabled' : ''}"
        data-action="open-bindings"
        ${disabled ? 'disabled aria-disabled="true"' : ''}
      >
        <span class="bindings-entry__label-group">
          <span class="bindings-entry__title">${i18n.t('nav.bindings')}</span>
          ${
            disabled
              ? `<span class="bindings-entry__hint">${i18n.t('bindings.connectHint')}</span>`
              : ''
          }
        </span>
        <span class="bindings-entry__chevron">›</span>
      </button>
    `;
  }

  private renderDiagnosticsPanel(): string {
    return `
      <section class="diagnostics ${this.state.diagnosticsExpanded ? 'diagnostics--open' : ''}">
        <button class="diagnostics__toggle" data-action="toggle-diagnostics">${i18n.t('app.diagnostics')}</button>
        <div class="diagnostics__body">
          ${this.renderDiagnosticsContent()}
        </div>
      </section>
    `;
  }

  private renderDiagnosticsContent(): string {
    const diag = this.diagnostics;
    const connected = diag.websocketConnected ? i18n.t('diagnostics.yes') : i18n.t('diagnostics.no');
    const session = diag.sessionId ? diag.sessionId.slice(0, 8) : i18n.t('diagnostics.unknown');
    const subs = diag.subscriptions.toString();
    const tokenType = diag.tokenType
      ? diag.tokenType === 'user'
        ? i18n.t('diagnostics.tokenUser')
        : diag.tokenType
      : i18n.t('diagnostics.unknown');
    const tokenClientId = diag.tokenClientId ?? i18n.t('diagnostics.unknown');
    const expiresIn =
      typeof diag.tokenExpiresIn === 'number'
        ? i18n.t('diagnostics.secondsRemaining', { seconds: diag.tokenExpiresIn })
        : i18n.t('diagnostics.unknown');
    const keepalive = this.formatDiagnosticsTime(diag.lastKeepaliveAt);
    const lastNotification = this.formatDiagnosticsTime(diag.lastNotificationAt);
    const notificationType = diag.lastNotificationType ?? i18n.t('diagnostics.unknown');
    const lastError = diag.lastError ?? i18n.t('diagnostics.none');

    return `
      <dl class="diagnostics__grid">
        <div><dt>${i18n.t('diagnostics.wsConnected')}</dt><dd>${connected}</dd></div>
        <div><dt>${i18n.t('diagnostics.sessionId')}</dt><dd>${session}</dd></div>
        <div><dt>${i18n.t('diagnostics.subscriptions')}</dt><dd>${subs}</dd></div>
        <div><dt>${i18n.t('diagnostics.tokenType')}</dt><dd>${tokenType}</dd></div>
        <div><dt>${i18n.t('diagnostics.tokenClientId')}</dt><dd>${tokenClientId}</dd></div>
        <div><dt>${i18n.t('diagnostics.tokenExpiresIn')}</dt><dd>${expiresIn}</dd></div>
        <div><dt>${i18n.t('diagnostics.lastKeepalive')}</dt><dd>${keepalive}</dd></div>
        <div><dt>${i18n.t('diagnostics.lastNotification')}</dt><dd>${lastNotification}</dd></div>
        <div><dt>${i18n.t('diagnostics.lastNotificationType')}</dt><dd>${notificationType}</dd></div>
        <div><dt>${i18n.t('diagnostics.lastError')}</dt><dd>${lastError}</dd></div>
      </dl>
    `;
  }

  private formatDiagnosticsTime(value: number | null): string {
    if (!value) {
      return i18n.t('diagnostics.unknown');
    }
    try {
      return new Date(value).toLocaleTimeString();
    } catch (error) {
      console.warn('[popup] Failed to format diagnostics time', error);
      return value.toString();
    }
  }

  private buildBindingsListView(): string {
    const items = this.state.bindings
      .map(
        (binding) => `
          <div class="binding-row" data-binding-id="${binding.id}">
            <label class="toggle binding-row__toggle">
              <input
                type="checkbox"
                data-role="binding-toggle"
                ${binding.enabled ? 'checked' : ''}
                aria-label="${i18n.t('bindings.toggleAria', { label: binding.label })}"
              />
              <span class="toggle__label visually-hidden">${i18n.t('bindings.toggleLabel')}</span>
            </label>
            <button
              type="button"
              class="binding-row__main"
              data-action="open-binding"
              data-binding-id="${binding.id}"
            >
              <span class="binding-row__label">${binding.label}</span>
              <span class="binding-row__chevron" aria-hidden="true">›</span>
            </button>
            <button
              type="button"
              class="btn btn--ghost binding-row__delete"
              data-action="delete-binding"
              data-binding-id="${binding.id}"
            >
              ${i18n.t('bindings.delete')}
            </button>
          </div>
        `
      )
      .join('');

    return `
      <div class="popup">
        <header class="popup__header popup__header--sub">
          <button class="icon-button" data-action="back">←</button>
          <h1 class="popup__title">${i18n.t('nav.bindings')}</h1>
          <button class="btn btn--primary" data-action="add-binding">${i18n.t('nav.addBinding')}</button>
        </header>
        <main class="popup__content">
          ${items || `<p class="empty">${i18n.t('bindings.empty')}</p>`}
        </main>
        ${this.renderDiagnosticsPanel()}
      </div>
    `;
  }

  private buildBindingEditorView(): string {
    if (!this.bindingDraft) {
      return '';
    }
    const isEditing = Boolean(this.bindingDraft.id);

    return `
      <div class="popup">
        <header class="popup__header popup__header--sub">
          <button class="icon-button" data-action="back">←</button>
          <h1 class="popup__title">${isEditing ? i18n.t('nav.editBinding') : i18n.t('nav.newBinding')}</h1>
          <div class="popup__header-actions"></div>
        </header>
        <main class="popup__content popup__content--form">
          <label class="field">
            <span class="field__label">${i18n.t('bindings.label')}</span>
            <input type="text" name="label" value="${this.bindingDraft.label}" autocomplete="off" />
          </label>
          <label class="field">
            <span class="field__label">${i18n.t('bindings.eventType')}</span>
            <select name="eventType">
              <option value="">${i18n.t('bindings.eventTypePlaceholder')}</option>
              <option value="channel_points" ${this.bindingDraft.eventType === 'channel_points' ? 'selected' : ''}>${i18n.t('bindings.channelPoints')}</option>
              <option value="bits" ${this.bindingDraft.eventType === 'bits' ? 'selected' : ''}>${i18n.t('bindings.bits')}</option>
              <option value="gift_sub" ${this.bindingDraft.eventType === 'gift_sub' ? 'selected' : ''}>${i18n.t('bindings.giftSub')}</option>
              <option value="sub" ${this.bindingDraft.eventType === 'sub' ? 'selected' : ''}>${i18n.t('bindings.sub')}</option>
              <option value="follow" ${this.bindingDraft.eventType === 'follow' ? 'selected' : ''}>${i18n.t('bindings.follow')}</option>
            </select>
          </label>
          ${this.renderBindingConditionalFields()}
          <label class="field">
            <span class="field__label">${i18n.t('bindings.action')}</span>
            <select name="action">
              <option value="">${i18n.t('bindings.actionPlaceholder')}</option>
              <option value="pitch" ${this.bindingDraft.action === 'pitch' ? 'selected' : ''}>${i18n.t('bindings.actionPitch')}</option>
              <option value="speed" ${this.bindingDraft.action === 'speed' ? 'selected' : ''}>${i18n.t('bindings.actionSpeed')}</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">${i18n.t('bindings.amount')}</span>
            <input type="number" name="amount" value="${this.bindingDraft.amount}" />
          </label>
          <div class="field field--stacked">
            <div class="field__label-row">
              <span class="field__label">${i18n.t('bindings.delay')}</span>
              <button
                type="button"
                class="info-icon"
                title="${i18n.t('bindings.delayHint')}"
                aria-label="${i18n.t('bindings.delayHint')}"
              >
                ?
              </button>
            </div>
            <input type="number" min="0" name="delaySeconds" value="${this.bindingDraft.delaySeconds}" />
          </div>
          <div class="field field--stacked">
            <div class="field__label-row">
              <span class="field__label">${i18n.t('bindings.duration')}</span>
              <button
                type="button"
                class="info-icon"
                title="${i18n.t('bindings.durationHint')}"
                aria-label="${i18n.t('bindings.durationHint')}"
              >
                ?
              </button>
            </div>
            <input type="number" min="0" name="durationSeconds" value="${this.bindingDraft.durationSeconds}" />
          </div>
          <div class="field field--stacked">
            <div class="field__label-row">
              <span class="field__label">${i18n.t('bindings.chatTemplate')}</span>
              <button class="link-button" type="button" data-action="insert-user">${i18n.t('bindings.insertUser')}</button>
            </div>
            <textarea name="chatTemplate" rows="3">${this.bindingDraft.chatTemplate}</textarea>
          </div>
          <button class="btn btn--primary" data-action="save-binding" ${this.bindingDraftIsValid() ? '' : 'disabled'}>
            ${i18n.t('bindings.save')}
          </button>
        </main>
        ${this.renderDiagnosticsPanel()}
      </div>
    `;
  }

  private renderBindingConditionalFields(): string {
    if (!this.bindingDraft) return '';
    switch (this.bindingDraft.eventType) {
      case 'channel_points':
        const rewardOptions = this.channelRewards
          .map((reward) => {
            const label = reward.cost != null ? `${reward.title} (${reward.cost})` : reward.title;
            const selected = this.bindingDraft?.channelPointsRewardId === reward.id ? 'selected' : '';
            return `<option value="${reward.id}" ${selected}>${label}</option>`;
          })
          .join('');
        const rewardDisabled = this.channelRewards.length === 0 ? 'disabled' : '';
        return `
          <label class="field">
            <span class="field__label">${i18n.t('bindings.channelPoints')}</span>
            <select name="channelReward" ${rewardDisabled}>
              <option value="">${i18n.t('bindings.rewardsPlaceholder')}</option>
              ${rewardOptions}
            </select>
          </label>
        `;
      case 'bits':
        return `
          <fieldset class="field-group">
            <legend>${i18n.t('bindings.bits')}</legend>
            <label class="field field--inline">
              <input type="radio" name="bitsMode" value="exact" ${this.bindingDraft.bitsMode === 'exact' ? 'checked' : ''} />
              <span class="field__label">${i18n.t('bindings.modeExact')}</span>
              <input class="field__inline-input" type="number" name="bitsExact" value="${this.bindingDraft.bitsExact}" ${this.bindingDraft.bitsMode === 'exact' ? '' : 'disabled'} />
            </label>
            <label class="field field--inline">
              <input type="radio" name="bitsMode" value="range" ${this.bindingDraft.bitsMode === 'range' ? 'checked' : ''} />
              <span class="field__label">${i18n.t('bindings.modeRange')}</span>
              <input class="field__inline-input" type="number" name="bitsMin" placeholder="${i18n.t('bindings.rangeMin')}" value="${this.bindingDraft.bitsMin}" ${this.bindingDraft.bitsMode === 'range' ? '' : 'disabled'} />
              <input class="field__inline-input" type="number" name="bitsMax" placeholder="${i18n.t('bindings.rangeMax')}" value="${this.bindingDraft.bitsMax}" ${this.bindingDraft.bitsMode === 'range' ? '' : 'disabled'} />
            </label>
          </fieldset>
        `;
      case 'gift_sub':
        return `
          <fieldset class="field-group">
            <legend>${i18n.t('bindings.giftSub')}</legend>
            <label class="field field--inline">
              <input type="radio" name="giftMode" value="exact" ${this.bindingDraft.giftMode === 'exact' ? 'checked' : ''} />
              <span class="field__label">${i18n.t('bindings.modeExact')}</span>
              <input class="field__inline-input" type="number" name="giftExact" value="${this.bindingDraft.giftExact}" ${this.bindingDraft.giftMode === 'exact' ? '' : 'disabled'} />
            </label>
            <label class="field field--inline">
              <input type="radio" name="giftMode" value="range" ${this.bindingDraft.giftMode === 'range' ? 'checked' : ''} />
              <span class="field__label">${i18n.t('bindings.modeRange')}</span>
              <input class="field__inline-input" type="number" name="giftMin" placeholder="${i18n.t('bindings.rangeMin')}" value="${this.bindingDraft.giftMin}" ${this.bindingDraft.giftMode === 'range' ? '' : 'disabled'} />
              <input class="field__inline-input" type="number" name="giftMax" placeholder="${i18n.t('bindings.rangeMax')}" value="${this.bindingDraft.giftMax}" ${this.bindingDraft.giftMode === 'range' ? '' : 'disabled'} />
            </label>
          </fieldset>
        `;
      case 'sub':
        return `
          <fieldset class="field-group">
            <legend>${i18n.t('bindings.sub')}</legend>
            <label class="field field--inline">
              <input type="checkbox" name="subTier" value="tier1" ${this.bindingDraft.subTiers.includes('tier1') ? 'checked' : ''} />
              <span class="field__label">${i18n.t('bindings.subTier1')}</span>
            </label>
            <label class="field field--inline">
              <input type="checkbox" name="subTier" value="tier2" ${this.bindingDraft.subTiers.includes('tier2') ? 'checked' : ''} />
              <span class="field__label">${i18n.t('bindings.subTier2')}</span>
            </label>
            <label class="field field--inline">
              <input type="checkbox" name="subTier" value="tier3" ${this.bindingDraft.subTiers.includes('tier3') ? 'checked' : ''} />
              <span class="field__label">${i18n.t('bindings.subTier3')}</span>
            </label>
          </fieldset>
        `;
      default:
        return '';
    }
  }

  private render(): void {
    this.clearDeleteConfirm();
    if (this.controlsDisabled() && this.editingValue) {
      this.cancelValueEdit(this.editingValue);
    }
    switch (this.view) {
      case 'main':
        this.root.innerHTML = this.buildMainView();
        this.bindMainEvents();
        break;
      case 'bindingsList':
        this.root.innerHTML = this.buildBindingsListView();
        this.bindBindingsListEvents();
        break;
      case 'bindingEditor':
        this.root.innerHTML = this.buildBindingEditorView();
        this.bindBindingEditorEvents();
        break;
      default:
        break;
    }
  }

  private bindMainEvents(): void {
    const transposeSlider = this.root.querySelector<HTMLInputElement>('[data-role="transpose-slider"]');
    const speedSlider = this.root.querySelector<HTMLInputElement>('[data-role="speed-slider"]');
    const transposeDec = this.root.querySelector<HTMLButtonElement>('[data-action="transpose-decrement"]');
    const transposeInc = this.root.querySelector<HTMLButtonElement>('[data-action="transpose-increment"]');
    const transposeReset = this.root.querySelector<HTMLButtonElement>('[data-action="transpose-reset"]');
    const speedDec = this.root.querySelector<HTMLButtonElement>('[data-action="speed-decrement"]');
    const speedInc = this.root.querySelector<HTMLButtonElement>('[data-action="speed-increment"]');
    const speedReset = this.root.querySelector<HTMLButtonElement>('[data-action="speed-reset"]');
    const languageToggle = this.root.querySelector<HTMLButtonElement>('[data-action="toggle-language"]');
    const languageButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('.language-menu .menu-item'));
    const twitchButton = this.root.querySelector<HTMLButtonElement>('[data-action="twitch-button"]');
    const captureToggle = this.root.querySelector<HTMLInputElement>('[data-role="capture-toggle"]');
    const testForm = this.root.querySelector<HTMLFormElement>('[data-role="test-events-form"]');
    const openBindings = this.root.querySelector<HTMLButtonElement>('[data-action="open-bindings"]');
    const diagnosticsToggle = this.root.querySelector<HTMLButtonElement>('[data-action="toggle-diagnostics"]');
    const refreshButton = this.root.querySelector<HTMLButtonElement>('[data-action="refresh-rewards"]');

    transposeSlider?.addEventListener('input', (event) => {
      const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
      this.setSemitone(value, { render: false, persist: false });
    });
    transposeSlider?.addEventListener('change', (event) => {
      const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
      this.setSemitone(value, { forcePersist: true, forceRender: true });
    });
    speedSlider?.addEventListener('input', (event) => {
      const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
      this.setSpeed(value, { render: false, persist: false });
    });
    speedSlider?.addEventListener('change', (event) => {
      const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
      this.setSpeed(value, { forcePersist: true, forceRender: true });
    });
    transposeDec?.addEventListener('click', () => this.adjustSemitone(-1));
    transposeInc?.addEventListener('click', () => this.adjustSemitone(1));
    transposeReset?.addEventListener('click', () => this.resetTranspose());
    speedDec?.addEventListener('click', () => this.adjustSpeed(-1));
    speedInc?.addEventListener('click', () => this.adjustSpeed(1));
    speedReset?.addEventListener('click', () => this.resetSpeed());
    languageToggle?.addEventListener('click', () => this.toggleLanguageMenu());
    languageButtons.forEach((button) =>
      button.addEventListener('click', () => {
        const code = button.dataset.langCode;
        if (code) this.selectLanguage(code);
      })
    );
    twitchButton?.addEventListener('click', () => {
      void this.handleTwitchButton();
    });
    captureToggle?.addEventListener('change', (event) => {
      const checked = (event.target as HTMLInputElement).checked;
      this.toggleCaptureEvents(checked);
    });
    refreshButton?.addEventListener('click', () => {
      void this.handleRefreshRewards();
    });
    if (testForm) {
      this.bindTestEvents(testForm);
    }

    if (openBindings && !openBindings.disabled) {
      openBindings.addEventListener('click', () => this.openBindingsList());
    }
    diagnosticsToggle?.addEventListener('click', () => this.toggleDiagnostics());
    this.bindEventLogControls();

    const transposeEditButton = this.root.querySelector<HTMLButtonElement>('[data-action="transpose-begin-edit"]');
    const speedEditButton = this.root.querySelector<HTMLButtonElement>('[data-action="speed-begin-edit"]');
    const transposeValueInput = this.root.querySelector<HTMLInputElement>('[data-role="transpose-value-input"]');
    const speedValueInput = this.root.querySelector<HTMLInputElement>('[data-role="speed-value-input"]');

    transposeEditButton?.addEventListener('click', () => this.beginValueEdit('transpose'));
    speedEditButton?.addEventListener('click', () => this.beginValueEdit('speed'));

    if (transposeValueInput) {
      transposeValueInput.addEventListener('input', (event) => {
        this.editingValueDraft = (event.target as HTMLInputElement).value;
      });
      transposeValueInput.addEventListener('blur', () => this.commitValueEdit('transpose'));
      transposeValueInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.commitValueEdit('transpose');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.cancelValueEdit('transpose');
        }
      });
    }

    if (speedValueInput) {
      speedValueInput.addEventListener('input', (event) => {
        this.editingValueDraft = (event.target as HTMLInputElement).value;
      });
      speedValueInput.addEventListener('blur', () => this.commitValueEdit('speed'));
      speedValueInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.commitValueEdit('speed');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.cancelValueEdit('speed');
        }
      });
    }

    this.focusEditingInput();
  }

  private bindEventLogControls(): void {
    const toggle = this.root.querySelector<HTMLButtonElement>('[data-action="toggle-event-log"]');
    toggle?.addEventListener('click', () => this.toggleEventLog());
  }

  private bindTestEvents(form: HTMLFormElement): void {
    const typeSelect = form.querySelector<HTMLSelectElement>('select[name="test-event-type"]');
    const usernameInput = form.querySelector<HTMLInputElement>('input[name="test-event-username"]');
    const rewardSelect = form.querySelector<HTMLSelectElement>('select[name="test-event-reward"]');
    const amountInput = form.querySelector<HTMLInputElement>('input[name="test-event-amount"]');
    const tierSelect = form.querySelector<HTMLSelectElement>('select[name="test-event-tier"]');

    typeSelect?.addEventListener('change', (event) => {
      const type = (event.target as HTMLSelectElement).value as TestEventType;
      const update: Partial<PopupPersistentState['testEvents']> = { type };
      if (!this.testEventNeedsAmount(type)) {
        update.amount = '';
      }
      if (!this.testEventNeedsReward(type)) {
        update.channelPointsRewardId = null;
      }
      if (!this.testEventNeedsTier(type)) {
        update.subTier = 'tier1';
      }
      this.updateTestEvents(update, { rerender: true });
    });

    usernameInput?.addEventListener('input', (event) => {
      this.updateTestEvents({ username: (event.target as HTMLInputElement).value });
    });

    rewardSelect?.addEventListener('change', (event) => {
      const value = (event.target as HTMLSelectElement).value || null;
      this.updateTestEvents({ channelPointsRewardId: value });
    });

    amountInput?.addEventListener('input', (event) => {
      this.updateTestEvents({ amount: (event.target as HTMLInputElement).value });
    });

    tierSelect?.addEventListener('change', (event) => {
      this.updateTestEvents({ subTier: (event.target as HTMLSelectElement).value as SubTier });
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.handleFireTest();
    });
  }

  private bindBindingsListEvents(): void {
    const backButton = this.root.querySelector<HTMLButtonElement>('[data-action="back"]');
    const addButton = this.root.querySelector<HTMLButtonElement>('[data-action="add-binding"]');
    const diagnosticsToggle = this.root.querySelector<HTMLButtonElement>('[data-action="toggle-diagnostics"]');

    backButton?.addEventListener('click', () => this.setView('main'));
    addButton?.addEventListener('click', () => this.openBindingEditor(null));
    diagnosticsToggle?.addEventListener('click', () => this.toggleDiagnostics());

    this.root.querySelectorAll<HTMLElement>('.binding-row').forEach((row) => {
      const id = row.dataset.bindingId;
      if (!id) return;
      const toggle = row.querySelector<HTMLInputElement>('[data-role="binding-toggle"]');
      const deleteButton = row.querySelector<HTMLButtonElement>('[data-action="delete-binding"]');
      const openButton = row.querySelector<HTMLButtonElement>('[data-action="open-binding"]');

      toggle?.addEventListener('click', (event) => event.stopPropagation());
      toggle?.addEventListener('change', (event) => {
        event.stopPropagation();
        const checked = (event.target as HTMLInputElement).checked;
        this.toggleBinding(id, checked);
      });

      if (openButton) {
        openButton.addEventListener('click', () => {
          row.classList.remove('binding-row--hover');
          this.openBindingEditor(id);
        });
        openButton.addEventListener('mouseenter', () => row.classList.add('binding-row--hover'));
        openButton.addEventListener('mouseleave', () => row.classList.remove('binding-row--hover'));
        openButton.addEventListener('focus', () => row.classList.add('binding-row--hover'));
        openButton.addEventListener('blur', () => row.classList.remove('binding-row--hover'));
      }

      deleteButton?.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!deleteButton) {
          return;
        }
        if (this.deleteConfirm?.id === id) {
          this.clearDeleteConfirm();
          this.deleteBinding(id);
        } else {
          this.setDeleteConfirm(deleteButton, id);
        }
      });
    });
  }

  private bindBindingEditorEvents(): void {
    const backButton = this.root.querySelector<HTMLButtonElement>('[data-action="back"]');
    const diagnosticsToggle = this.root.querySelector<HTMLButtonElement>('[data-action="toggle-diagnostics"]');
    const saveButton = this.root.querySelector<HTMLButtonElement>('[data-action="save-binding"]');
    const insertUser = this.root.querySelector<HTMLButtonElement>('[data-action="insert-user"]');

    backButton?.addEventListener('click', async () => {
      const leave = await this.maybeLeaveBindingEditor();
      if (leave) {
        this.bindingDraft = null;
        this.bindingDraftInitial = null;
        this.openBindingsList();
      }
    });

    diagnosticsToggle?.addEventListener('click', () => this.toggleDiagnostics());

    const form = this.root.querySelector('.popup__content--form');
    if (!form || !this.bindingDraft) return;

    form.querySelectorAll<HTMLInputElement>('input[name="label"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ label: (event.target as HTMLInputElement).value }))
    );

    form.querySelectorAll<HTMLSelectElement>('select[name="eventType"]').forEach((select) =>
      select.addEventListener('change', (event) => {
        const value = (event.target as HTMLSelectElement).value as BindingEventType | '';
        const update: Partial<BindingDraft> = { eventType: value };
        if (value === 'channel_points') {
          const current = this.bindingDraft?.channelPointsRewardId ?? null;
          const hasCurrent = current ? this.channelRewards.some((reward) => reward.id === current) : false;
          update.channelPointsRewardId = hasCurrent ? current : this.channelRewards[0]?.id ?? null;
        } else {
          update.channelPointsRewardId = null;
        }
        if (value === 'sub' && this.bindingDraft && this.bindingDraft.subTiers.length === 0) {
          update.subTiers = ['tier1'];
        }
        this.updateBindingDraft(update, { rerender: true });
      })
    );

    form.querySelectorAll<HTMLSelectElement>('select[name="channelReward"]').forEach((select) =>
      select.addEventListener('change', (event) => {
        const value = (event.target as HTMLSelectElement).value;
        this.updateBindingDraft({ channelPointsRewardId: value ? value : null });
      })
    );

    form.querySelectorAll<HTMLInputElement>('input[name="bitsMode"]').forEach((input) =>
      input.addEventListener('change', (event) =>
        this.updateBindingDraft({ bitsMode: (event.target as HTMLInputElement).value as 'exact' | 'range' }, { rerender: true })
      )
    );

    form.querySelectorAll<HTMLInputElement>('input[name="bitsExact"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ bitsExact: (event.target as HTMLInputElement).value }))
    );
    form.querySelectorAll<HTMLInputElement>('input[name="bitsMin"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ bitsMin: (event.target as HTMLInputElement).value }))
    );
    form.querySelectorAll<HTMLInputElement>('input[name="bitsMax"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ bitsMax: (event.target as HTMLInputElement).value }))
    );

    form.querySelectorAll<HTMLInputElement>('input[name="giftMode"]').forEach((input) =>
      input.addEventListener('change', (event) =>
        this.updateBindingDraft({ giftMode: (event.target as HTMLInputElement).value as 'exact' | 'range' }, { rerender: true })
      )
    );
    form.querySelectorAll<HTMLInputElement>('input[name="giftExact"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ giftExact: (event.target as HTMLInputElement).value }))
    );
    form.querySelectorAll<HTMLInputElement>('input[name="giftMin"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ giftMin: (event.target as HTMLInputElement).value }))
    );
    form.querySelectorAll<HTMLInputElement>('input[name="giftMax"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ giftMax: (event.target as HTMLInputElement).value }))
    );

    form.querySelectorAll<HTMLInputElement>('input[name="subTier"]').forEach((input) =>
      input.addEventListener('change', (event) => {
        const checkbox = event.target as HTMLInputElement;
        this.updateBindingDraftTier(checkbox.value as SubTier, checkbox.checked);
      })
    );

    form.querySelectorAll<HTMLSelectElement>('select[name="action"]').forEach((select) =>
      select.addEventListener('change', (event) => this.updateBindingDraft({ action: (event.target as HTMLSelectElement).value as 'pitch' | 'speed' | '' }))
    );

    form.querySelectorAll<HTMLInputElement>('input[name="amount"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ amount: (event.target as HTMLInputElement).value }))
    );

    form.querySelectorAll<HTMLInputElement>('input[name="delaySeconds"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ delaySeconds: (event.target as HTMLInputElement).value }))
    );
    form.querySelectorAll<HTMLInputElement>('input[name="durationSeconds"]').forEach((input) =>
      input.addEventListener('input', (event) => this.updateBindingDraft({ durationSeconds: (event.target as HTMLInputElement).value }))
    );

    form.querySelectorAll<HTMLTextAreaElement>('textarea[name="chatTemplate"]').forEach((textarea) =>
      textarea.addEventListener('input', (event) => this.updateBindingDraft({ chatTemplate: (event.target as HTMLTextAreaElement).value }))
    );

    insertUser?.addEventListener('click', () => this.insertUserTemplate());

    saveButton?.addEventListener('click', () => {
      if (this.bindingDraftIsValid()) {
        this.commitBindingDraft();
      }
    });

    this.refreshBindingEditorSaveState();
  }
}

const popupApp = new PopupApp(appRoot);
void popupApp.init();
