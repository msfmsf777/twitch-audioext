import { i18n } from '../shared/i18n';
import type { BackgroundToPopupMessage, PopupToBackgroundMessage } from '../shared/messages';
import {
  createDefaultPopupState,
  type BindingDefinition,
  type BindingEventType,
  type PopupPersistentState,
  type SubTier
} from '../shared/state';

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

  constructor(private readonly root: HTMLElement) {
    this.toast = new ToastManager(root);
    this.confirmDialog = new ConfirmDialog(root);
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

  private async persistState(): Promise<void> {
    const response = await sendPopupMessage({ type: 'POPUP_UPDATE_STATE', state: this.state });
    if (response?.type === 'BACKGROUND_STATE') {
      this.state = response.state;
    }
  }

  private persistDiagnostics(expanded: boolean): void {
    this.state = { ...this.state, diagnosticsExpanded: expanded };
    void sendPopupMessage({ type: 'POPUP_TOGGLE_DEVTOOLS', expanded }).then((response) => {
      if (response?.type === 'BACKGROUND_DEVTOOLS') {
        this.state = { ...this.state, diagnosticsExpanded: response.expanded };
      }
    });
  }

  private setView(view: PopupView): void {
    this.view = view;
    this.render();
  }

  private openBindingsList(): void {
    this.setView('bindingsList');
  }

  private openBindingEditor(bindingId: string | null): void {
    this.bindingDraft = this.createBindingDraft(bindingId);
    this.bindingDraftInitial = JSON.parse(JSON.stringify(this.bindingDraft));
    this.view = 'bindingEditor';
    this.render();
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
            binding.config.type === 'channel_points' ? binding.config.rewardId : null,
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
        return { type: 'channel_points', rewardId: draft.channelPointsRewardId };
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

  private deleteBinding(id: string): void {
    const bindings = this.state.bindings.filter((entry) => entry.id !== id);
    this.state = { ...this.state, bindings };
    void this.persistState();
    this.toast.show(i18n.t('toasts.bindingDeleted'));
    this.render();
  }

  private toggleBinding(id: string, enabled: boolean): void {
    const bindings = this.state.bindings.map((entry) => (entry.id === id ? { ...entry, enabled } : entry));
    this.state = { ...this.state, bindings };
    void this.persistState();
    this.render();
  }

  private updateTestEvents(updater: (state: PopupPersistentState['testEvents']) => PopupPersistentState['testEvents']): void {
    this.state = { ...this.state, testEvents: updater(this.state.testEvents) };
    this.render();
    void this.persistState();
  }

  private adjustSemitone(delta: number): void {
    const value = Math.max(-12, Math.min(12, this.state.semitoneOffset + delta));
    this.state = { ...this.state, semitoneOffset: value };
    this.render();
    void this.persistState();
  }

  private setSemitone(value: number): void {
    this.state = { ...this.state, semitoneOffset: value };
    this.render();
    void this.persistState();
  }

  private adjustSpeed(delta: number): void {
    const next = Math.max(50, Math.min(200, this.state.speedPercent + delta));
    this.state = { ...this.state, speedPercent: next };
    this.render();
    void this.persistState();
  }

  private setSpeed(value: number): void {
    const bounded = Math.max(50, Math.min(200, value));
    this.state = { ...this.state, speedPercent: bounded };
    this.render();
    void this.persistState();
  }

  private resetTranspose(): void {
    this.setSemitone(0);
  }

  private resetSpeed(): void {
    this.setSpeed(100);
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

  private stubTwitchButton(): void {
    if (this.state.loggedIn) {
      this.state = { ...this.state, loggedIn: false };
    } else if (this.state.twitchDisplayName) {
      this.state = { ...this.state, loggedIn: true };
    } else {
      this.state = { ...this.state, loggedIn: true, twitchDisplayName: 'SampleStreamer' };
    }
    this.render();
    void this.persistState();
  }

  private toggleCaptureEvents(enabled: boolean): void {
    this.toggleCapture(enabled);
  }

  private toggleDiagnostics(): void {
    this.persistDiagnostics(!this.state.diagnosticsExpanded);
    this.render();
  }

  private handleFireTest(): void {
    const payload = {
      channelPointsRewardId: this.state.testEvents.channelPointsRewardId,
      bits: this.state.testEvents.bits,
      giftSubs: this.state.testEvents.giftSubs,
      subTiers: this.state.testEvents.subTiers
    };
    console.info('[popup] Test event payload', payload);
    this.toast.show(i18n.t('toasts.testFired'));
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
      this.bindingDraft.chatTemplate = newValue;
      this.render();
    }
  }
  private updateBindingDraft(update: Partial<BindingDraft>): void {
    if (!this.bindingDraft) return;
    this.bindingDraft = { ...this.bindingDraft, ...update };
    this.render();
  }

  private updateBindingDraftTier(tier: SubTier, checked: boolean): void {
    if (!this.bindingDraft) return;
    const tiers = new Set(this.bindingDraft.subTiers);
    if (checked) tiers.add(tier);
    else tiers.delete(tier);
    this.bindingDraft = { ...this.bindingDraft, subTiers: Array.from(tiers) };
    this.render();
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

    const twitchStatus = this.state.loggedIn
      ? i18n.t('twitch.statusConnected', { displayName: this.state.twitchDisplayName ?? '—' })
      : i18n.t('twitch.statusDisconnected');

    const twitchButtonLabel = this.state.loggedIn
      ? i18n.t('twitch.disconnect')
      : this.state.twitchDisplayName
      ? i18n.t('twitch.reconnect')
      : i18n.t('twitch.connect');

    const testDisabled = !this.state.loggedIn;

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
          ${this.renderTwitchRow(twitchStatus, twitchButtonLabel)}
          ${this.renderTestEventsBlock(testDisabled)}
          ${this.renderBindingsEntry()}
        </main>
        ${this.renderDiagnosticsPanel()}
      </div>
    `;
  }

  private renderTransposeBlock(): string {
    return `
      <section class="panel">
        <div class="panel__header">
          <h2>${i18n.t('transpose.title')}</h2>
          <span class="panel__value">${this.state.semitoneOffset > 0 ? '+' : ''}${this.state.semitoneOffset}</span>
        </div>
        <input type="range" min="-12" max="12" step="1" value="${this.state.semitoneOffset}" data-role="transpose-slider" />
        <div class="panel__controls">
          <button class="btn" data-action="transpose-decrement">${i18n.t('transpose.decrement')}</button>
          <button class="btn" data-action="transpose-increment">${i18n.t('transpose.increment')}</button>
          <button class="btn btn--secondary" data-action="transpose-reset">${i18n.t('transpose.reset')}</button>
        </div>
      </section>
    `;
  }

  private renderSpeedBlock(): string {
    return `
      <section class="panel">
        <div class="panel__header">
          <h2>${i18n.t('speed.title')}</h2>
          <span class="panel__value">${this.state.speedPercent}%</span>
        </div>
        <input type="range" min="50" max="200" step="1" value="${this.state.speedPercent}" data-role="speed-slider" />
        <div class="panel__controls">
          <button class="btn" data-action="speed-decrement">${i18n.t('transpose.decrement')}</button>
          <button class="btn" data-action="speed-increment">${i18n.t('transpose.increment')}</button>
          <button class="btn btn--secondary" data-action="speed-reset">${i18n.t('transpose.reset')}</button>
        </div>
      </section>
    `;
  }

  private renderTwitchRow(status: string, buttonLabel: string): string {
    return `
      <section class="twitch-row">
        <div class="twitch-row__status">
          <span class="twitch-row__icon">🟣</span>
          <span class="twitch-row__text">${status}</span>
        </div>
        <div class="twitch-row__actions">
          <button class="btn btn--primary" data-action="twitch-button">${buttonLabel}</button>
          <label class="toggle">
            <input type="checkbox" data-role="capture-toggle" ${this.state.captureEvents ? 'checked' : ''} />
            <span class="toggle__label" title="${i18n.t('twitch.captureTooltip')}">
              ${i18n.t('twitch.captureToggle')}
            </span>
          </label>
        </div>
      </section>
    `;
  }

  private renderTestEventsBlock(disabled: boolean): string {
    const { testEvents } = this.state;
    const bitsExactChecked = testEvents.bits.mode === 'exact';
    const giftExactChecked = testEvents.giftSubs.mode === 'exact';
    const subTiers = testEvents.subTiers;

    return `
      <section class="panel test-events ${disabled ? 'panel--disabled' : ''}">
        <div class="panel__header">
          <h2>${i18n.t('testEvents.title')}</h2>
          ${disabled ? `<span class="badge">${i18n.t('testEvents.requiresLogin')}</span>` : ''}
        </div>
        <div class="test-events__fields">
          <label class="field">
            <span>${i18n.t('bindings.channelPoints')}</span>
            <select name="test-channel-points" ${disabled ? 'disabled' : ''}>
              <option value="">${i18n.t('testEvents.rewardPlaceholder')}</option>
            </select>
          </label>
          <fieldset class="field-group" ${disabled ? 'disabled' : ''}>
            <legend>${i18n.t('bindings.bits')}</legend>
            <label class="field field--inline">
              <input type="radio" name="bits-mode" value="exact" ${bitsExactChecked ? 'checked' : ''} />
              <span>${i18n.t('testEvents.bitsExact')}</span>
              <input type="number" name="bits-exact" value="${testEvents.bits.exact ?? ''}" ${bitsExactChecked ? '' : 'disabled'} />
            </label>
            <label class="field field--inline">
              <input type="radio" name="bits-mode" value="range" ${bitsExactChecked ? '' : 'checked'} />
              <span>${i18n.t('testEvents.bitsRange')}</span>
              <input type="number" name="bits-min" placeholder="${i18n.t('testEvents.min')}" value="${testEvents.bits.min ?? ''}" ${bitsExactChecked ? 'disabled' : ''} />
              <input type="number" name="bits-max" placeholder="${i18n.t('testEvents.max')}" value="${testEvents.bits.max ?? ''}" ${bitsExactChecked ? 'disabled' : ''} />
            </label>
          </fieldset>
          <fieldset class="field-group" ${disabled ? 'disabled' : ''}>
            <legend>${i18n.t('bindings.giftSub')}</legend>
            <label class="field field--inline">
              <input type="radio" name="gift-mode" value="exact" ${giftExactChecked ? 'checked' : ''} />
              <span>${i18n.t('testEvents.giftExact')}</span>
              <input type="number" name="gift-exact" value="${testEvents.giftSubs.exact ?? ''}" ${giftExactChecked ? '' : 'disabled'} />
            </label>
            <label class="field field--inline">
              <input type="radio" name="gift-mode" value="range" ${giftExactChecked ? '' : 'checked'} />
              <span>${i18n.t('testEvents.giftRange')}</span>
              <input type="number" name="gift-min" placeholder="${i18n.t('testEvents.min')}" value="${testEvents.giftSubs.min ?? ''}" ${giftExactChecked ? 'disabled' : ''} />
              <input type="number" name="gift-max" placeholder="${i18n.t('testEvents.max')}" value="${testEvents.giftSubs.max ?? ''}" ${giftExactChecked ? 'disabled' : ''} />
            </label>
          </fieldset>
          <fieldset class="field-group" ${disabled ? 'disabled' : ''}>
            <legend>${i18n.t('bindings.sub')}</legend>
            <label class="field field--inline">
              <input type="checkbox" value="tier1" ${subTiers.includes('tier1') ? 'checked' : ''} />
              <span>${i18n.t('testEvents.tier1')}</span>
            </label>
            <label class="field field--inline">
              <input type="checkbox" value="tier2" ${subTiers.includes('tier2') ? 'checked' : ''} />
              <span>${i18n.t('testEvents.tier2')}</span>
            </label>
            <label class="field field--inline">
              <input type="checkbox" value="tier3" ${subTiers.includes('tier3') ? 'checked' : ''} />
              <span>${i18n.t('testEvents.tier3')}</span>
            </label>
          </fieldset>
        </div>
        <button class="btn btn--primary" data-action="fire-test" ${disabled ? 'disabled' : ''}>${i18n.t('testEvents.fire')}</button>
      </section>
    `;
  }

  private renderBindingsEntry(): string {
    return `
      <button class="bindings-entry" data-action="open-bindings">
        <span>${i18n.t('nav.bindings')}</span>
        <span class="bindings-entry__chevron">›</span>
      </button>
    `;
  }

  private renderDiagnosticsPanel(): string {
    return `
      <section class="diagnostics ${this.state.diagnosticsExpanded ? 'diagnostics--open' : ''}">
        <button class="diagnostics__toggle" data-action="toggle-diagnostics">${i18n.t('app.diagnostics')}</button>
        <div class="diagnostics__body">
          <pre>${JSON.stringify(this.state, null, 2)}</pre>
        </div>
      </section>
    `;
  }

  private buildBindingsListView(): string {
    const items = this.state.bindings
      .map(
        (binding) => `
          <div class="binding-row" data-binding-id="${binding.id}">
            <label class="toggle">
              <input type="checkbox" data-role="binding-toggle" ${binding.enabled ? 'checked' : ''} />
              <span class="toggle__label">${binding.label}</span>
            </label>
            <div class="binding-row__actions">
              <button class="btn btn--ghost" data-action="delete-binding">${i18n.t('bindings.delete')}</button>
              <span class="binding-row__chevron">›</span>
            </div>
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
    const amountHint =
      this.bindingDraft.action === 'pitch'
        ? i18n.t('bindings.amountHintPitch')
        : this.bindingDraft.action === 'speed'
        ? i18n.t('bindings.amountHintSpeed')
        : '';

    return `
      <div class="popup">
        <header class="popup__header popup__header--sub">
          <button class="icon-button" data-action="back">←</button>
          <h1 class="popup__title">${isEditing ? i18n.t('nav.editBinding') : i18n.t('nav.newBinding')}</h1>
          <div class="popup__header-actions"></div>
        </header>
        <main class="popup__content popup__content--form">
          <label class="field">
            <span>${i18n.t('bindings.label')}</span>
            <input type="text" name="label" value="${this.bindingDraft.label}" />
          </label>
          <label class="field">
            <span>${i18n.t('bindings.eventType')}</span>
            <select name="eventType" value="${this.bindingDraft.eventType}">
              <option value="">--</option>
              <option value="channel_points" ${this.bindingDraft.eventType === 'channel_points' ? 'selected' : ''}>${i18n.t('bindings.channelPoints')}</option>
              <option value="bits" ${this.bindingDraft.eventType === 'bits' ? 'selected' : ''}>${i18n.t('bindings.bits')}</option>
              <option value="gift_sub" ${this.bindingDraft.eventType === 'gift_sub' ? 'selected' : ''}>${i18n.t('bindings.giftSub')}</option>
              <option value="sub" ${this.bindingDraft.eventType === 'sub' ? 'selected' : ''}>${i18n.t('bindings.sub')}</option>
              <option value="follow" ${this.bindingDraft.eventType === 'follow' ? 'selected' : ''}>${i18n.t('bindings.follow')}</option>
            </select>
          </label>
          ${this.renderBindingConditionalFields()}
          <label class="field">
            <span>${i18n.t('bindings.action')}</span>
            <select name="action" value="${this.bindingDraft.action}">
              <option value="">--</option>
              <option value="pitch" ${this.bindingDraft.action === 'pitch' ? 'selected' : ''}>${i18n.t('bindings.actionPitch')}</option>
              <option value="speed" ${this.bindingDraft.action === 'speed' ? 'selected' : ''}>${i18n.t('bindings.actionSpeed')}</option>
            </select>
          </label>
          <label class="field">
            <span>${i18n.t('bindings.amount')}</span>
            <input type="number" name="amount" value="${this.bindingDraft.amount}" placeholder="${amountHint}" />
          </label>
          <label class="field field--with-tooltip">
            <span>${i18n.t('bindings.delay')}</span>
            <input type="number" min="0" name="delaySeconds" value="${this.bindingDraft.delaySeconds}" />
            <span class="tooltip" title="${i18n.t('bindings.delayHint')}">?</span>
          </label>
          <label class="field field--with-tooltip">
            <span>${i18n.t('bindings.duration')}</span>
            <input type="number" min="0" name="durationSeconds" value="${this.bindingDraft.durationSeconds}" />
            <span class="tooltip" title="${i18n.t('bindings.durationHint')}">?</span>
          </label>
          <div class="field field--stacked">
            <label>${i18n.t('bindings.chatTemplate')}</label>
            <div class="chat-template">
              <button class="btn btn--secondary" type="button" data-action="insert-user">${i18n.t('bindings.insertUser')}</button>
              <textarea name="chatTemplate" rows="3">${this.bindingDraft.chatTemplate}</textarea>
            </div>
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
        return `
          <label class="field">
            <span>${i18n.t('bindings.channelPoints')}</span>
            <select name="channelReward" disabled>
              <option value="">${i18n.t('bindings.rewardsPlaceholder')}</option>
            </select>
          </label>
        `;
      case 'bits':
        return `
          <fieldset class="field-group">
            <legend>${i18n.t('bindings.bits')}</legend>
            <label class="field field--inline">
              <input type="radio" name="bitsMode" value="exact" ${this.bindingDraft.bitsMode === 'exact' ? 'checked' : ''} />
              <span>${i18n.t('bindings.modeExact')}</span>
              <input type="number" name="bitsExact" value="${this.bindingDraft.bitsExact}" ${this.bindingDraft.bitsMode === 'exact' ? '' : 'disabled'} />
            </label>
            <label class="field field--inline">
              <input type="radio" name="bitsMode" value="range" ${this.bindingDraft.bitsMode === 'range' ? 'checked' : ''} />
              <span>${i18n.t('bindings.modeRange')}</span>
              <input type="number" name="bitsMin" placeholder="${i18n.t('bindings.rangeMin')}" value="${this.bindingDraft.bitsMin}" ${this.bindingDraft.bitsMode === 'range' ? '' : 'disabled'} />
              <input type="number" name="bitsMax" placeholder="${i18n.t('bindings.rangeMax')}" value="${this.bindingDraft.bitsMax}" ${this.bindingDraft.bitsMode === 'range' ? '' : 'disabled'} />
            </label>
          </fieldset>
        `;
      case 'gift_sub':
        return `
          <fieldset class="field-group">
            <legend>${i18n.t('bindings.giftSub')}</legend>
            <label class="field field--inline">
              <input type="radio" name="giftMode" value="exact" ${this.bindingDraft.giftMode === 'exact' ? 'checked' : ''} />
              <span>${i18n.t('bindings.modeExact')}</span>
              <input type="number" name="giftExact" value="${this.bindingDraft.giftExact}" ${this.bindingDraft.giftMode === 'exact' ? '' : 'disabled'} />
            </label>
            <label class="field field--inline">
              <input type="radio" name="giftMode" value="range" ${this.bindingDraft.giftMode === 'range' ? 'checked' : ''} />
              <span>${i18n.t('bindings.modeRange')}</span>
              <input type="number" name="giftMin" placeholder="${i18n.t('bindings.rangeMin')}" value="${this.bindingDraft.giftMin}" ${this.bindingDraft.giftMode === 'range' ? '' : 'disabled'} />
              <input type="number" name="giftMax" placeholder="${i18n.t('bindings.rangeMax')}" value="${this.bindingDraft.giftMax}" ${this.bindingDraft.giftMode === 'range' ? '' : 'disabled'} />
            </label>
          </fieldset>
        `;
      case 'sub':
        return `
          <fieldset class="field-group">
            <legend>${i18n.t('bindings.sub')}</legend>
            <label class="field field--inline">
              <input type="checkbox" name="subTier" value="tier1" ${this.bindingDraft.subTiers.includes('tier1') ? 'checked' : ''} />
              <span>${i18n.t('bindings.subTier1')}</span>
            </label>
            <label class="field field--inline">
              <input type="checkbox" name="subTier" value="tier2" ${this.bindingDraft.subTiers.includes('tier2') ? 'checked' : ''} />
              <span>${i18n.t('bindings.subTier2')}</span>
            </label>
            <label class="field field--inline">
              <input type="checkbox" name="subTier" value="tier3" ${this.bindingDraft.subTiers.includes('tier3') ? 'checked' : ''} />
              <span>${i18n.t('bindings.subTier3')}</span>
            </label>
          </fieldset>
        `;
      default:
        return '';
    }
  }

  private render(): void {
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
    const fireTest = this.root.querySelector<HTMLButtonElement>('[data-action="fire-test"]');
    const openBindings = this.root.querySelector<HTMLButtonElement>('[data-action="open-bindings"]');
    const diagnosticsToggle = this.root.querySelector<HTMLButtonElement>('[data-action="toggle-diagnostics"]');

    transposeSlider?.addEventListener('input', (event) => {
      const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
      this.setSemitone(value);
    });
    speedSlider?.addEventListener('input', (event) => {
      const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
      this.setSpeed(value);
    });
    transposeDec?.addEventListener('click', () => this.adjustSemitone(-1));
    transposeInc?.addEventListener('click', () => this.adjustSemitone(1));
    transposeReset?.addEventListener('click', () => this.resetTranspose());
    speedDec?.addEventListener('click', () => this.adjustSpeed(-5));
    speedInc?.addEventListener('click', () => this.adjustSpeed(5));
    speedReset?.addEventListener('click', () => this.resetSpeed());
    languageToggle?.addEventListener('click', () => this.toggleLanguageMenu());
    languageButtons.forEach((button) =>
      button.addEventListener('click', () => {
        const code = button.dataset.langCode;
        if (code) this.selectLanguage(code);
      })
    );
    twitchButton?.addEventListener('click', () => this.stubTwitchButton());
    captureToggle?.addEventListener('change', (event) => {
      const checked = (event.target as HTMLInputElement).checked;
      this.toggleCaptureEvents(checked);
    });

    const testSection = this.root.querySelector<HTMLElement>('.test-events');
    if (testSection && !testSection.classList.contains('panel--disabled')) {
      this.bindTestEvents(testSection);
    }

    fireTest?.addEventListener('click', () => this.handleFireTest());
    openBindings?.addEventListener('click', () => this.openBindingsList());
    diagnosticsToggle?.addEventListener('click', () => this.toggleDiagnostics());
  }

  private bindTestEvents(container: HTMLElement): void {
    const channelSelect = container.querySelector<HTMLSelectElement>('select[name="test-channel-points"]');
    const bitsModeInputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[name="bits-mode"]'));
    const bitsExact = container.querySelector<HTMLInputElement>('input[name="bits-exact"]');
    const bitsMin = container.querySelector<HTMLInputElement>('input[name="bits-min"]');
    const bitsMax = container.querySelector<HTMLInputElement>('input[name="bits-max"]');
    const giftModeInputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[name="gift-mode"]'));
    const giftExact = container.querySelector<HTMLInputElement>('input[name="gift-exact"]');
    const giftMin = container.querySelector<HTMLInputElement>('input[name="gift-min"]');
    const giftMax = container.querySelector<HTMLInputElement>('input[name="gift-max"]');
    const subTierInputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"][value^="tier"]'));

    channelSelect?.addEventListener('change', (event) => {
      const value = (event.target as HTMLSelectElement).value || null;
      this.updateTestEvents((state) => ({ ...state, channelPointsRewardId: value }));
    });

    bitsModeInputs.forEach((input) =>
      input.addEventListener('change', (event) => {
        const mode = (event.target as HTMLInputElement).value as 'exact' | 'range';
        this.updateTestEvents((state) => ({ ...state, bits: { ...state.bits, mode } }));
      })
    );

    bitsExact?.addEventListener('input', (event) => {
      const value = (event.target as HTMLInputElement).value;
      this.updateTestEvents((state) => ({
        ...state,
        bits: { ...state.bits, exact: value ? Number.parseFloat(value) : null }
      }));
    });

    bitsMin?.addEventListener('input', (event) => {
      const value = (event.target as HTMLInputElement).value;
      this.updateTestEvents((state) => ({
        ...state,
        bits: { ...state.bits, min: value ? Number.parseFloat(value) : null }
      }));
    });

    bitsMax?.addEventListener('input', (event) => {
      const value = (event.target as HTMLInputElement).value;
      this.updateTestEvents((state) => ({
        ...state,
        bits: { ...state.bits, max: value ? Number.parseFloat(value) : null }
      }));
    });

    giftModeInputs.forEach((input) =>
      input.addEventListener('change', (event) => {
        const mode = (event.target as HTMLInputElement).value as 'exact' | 'range';
        this.updateTestEvents((state) => ({ ...state, giftSubs: { ...state.giftSubs, mode } }));
      })
    );

    giftExact?.addEventListener('input', (event) => {
      const value = (event.target as HTMLInputElement).value;
      this.updateTestEvents((state) => ({
        ...state,
        giftSubs: { ...state.giftSubs, exact: value ? Number.parseFloat(value) : null }
      }));
    });

    giftMin?.addEventListener('input', (event) => {
      const value = (event.target as HTMLInputElement).value;
      this.updateTestEvents((state) => ({
        ...state,
        giftSubs: { ...state.giftSubs, min: value ? Number.parseFloat(value) : null }
      }));
    });

    giftMax?.addEventListener('input', (event) => {
      const value = (event.target as HTMLInputElement).value;
      this.updateTestEvents((state) => ({
        ...state,
        giftSubs: { ...state.giftSubs, max: value ? Number.parseFloat(value) : null }
      }));
    });

    subTierInputs.forEach((input) =>
      input.addEventListener('change', (event) => {
        const checkbox = event.target as HTMLInputElement;
        const tier = checkbox.value as SubTier;
        this.updateTestEvents((state) => {
          const set = new Set(state.subTiers);
          if (checkbox.checked) set.add(tier);
          else set.delete(tier);
          const next = Array.from(set);
          return { ...state, subTiers: next.length > 0 ? next : [] };
        });
      })
    );
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

      toggle?.addEventListener('change', (event) => {
        const checked = (event.target as HTMLInputElement).checked;
        this.toggleBinding(id, checked);
      });

      deleteButton?.addEventListener('click', (event) => {
        event.stopPropagation();
        this.deleteBinding(id);
      });

      row.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('button')) {
          return;
        }
        this.openBindingEditor(id);
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
      select.addEventListener('change', (event) => this.updateBindingDraft({ eventType: (event.target as HTMLSelectElement).value as BindingEventType | '' }))
    );

    form.querySelectorAll<HTMLInputElement>('input[name="bitsMode"]').forEach((input) =>
      input.addEventListener('change', (event) => this.updateBindingDraft({ bitsMode: (event.target as HTMLInputElement).value as 'exact' | 'range' }))
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
      input.addEventListener('change', (event) => this.updateBindingDraft({ giftMode: (event.target as HTMLInputElement).value as 'exact' | 'range' }))
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
  }
}

const popupApp = new PopupApp(appRoot);
void popupApp.init();
