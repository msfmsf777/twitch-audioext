type LocaleManifestEntry = {
  code: string;
  name: string;
};

type Listener = (code: string) => void;

function getStringFromPath(data: unknown, path: string[]): string | undefined {
  let current: any = data;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === 'string' ? current : undefined;
}

export class I18nService {
  private localeData = new Map<string, Record<string, unknown>>();
  private manifest: LocaleManifestEntry[] = [];
  private listeners: Listener[] = [];
  private activeCode = 'en';

  async init(preferred?: string): Promise<void> {
    await this.loadManifest();
    await this.loadLocales();
    if (preferred && this.localeData.has(preferred)) {
      this.activeCode = preferred;
    } else if (this.localeData.has('en')) {
      this.activeCode = 'en';
    } else if (this.manifest.length > 0) {
      this.activeCode = this.manifest[0].code;
    }
  }

  private async loadManifest(): Promise<void> {
    const url = chrome.runtime.getURL('locales/index.json');
    const response = await fetch(url);
    this.manifest = (await response.json()) as LocaleManifestEntry[];
  }

  private async loadLocales(): Promise<void> {
    const promises = this.manifest.map(async ({ code }) => {
      const url = chrome.runtime.getURL(`locales/${code}.json`);
      const response = await fetch(url);
      const data = (await response.json()) as Record<string, unknown>;
      this.localeData.set(code, data);
    });
    await Promise.all(promises);
  }

  getAvailableLocales(): LocaleManifestEntry[] {
    return [...this.manifest];
  }

  getLocaleName(code: string): string | undefined {
    return this.manifest.find((entry) => entry.code === code)?.name;
  }

  getActiveCode(): string {
    return this.activeCode;
  }

  setActiveCode(code: string): void {
    if (!this.localeData.has(code) || this.activeCode === code) {
      return;
    }
    this.activeCode = code;
    for (const listener of this.listeners) {
      listener(code);
    }
  }

  onChange(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  t(path: string, replacements: Record<string, string | number> = {}): string {
    const segments = path.split('.');
    const prefer = this.localeData.get(this.activeCode);
    const fallback = this.localeData.get('en');
    const raw =
      (prefer && getStringFromPath(prefer, segments)) ||
      (fallback && getStringFromPath(fallback, segments)) ||
      path;
    return raw.replace(/\{(\w+)\}/g, (match, key) => {
      const replacement = replacements[key];
      return replacement !== undefined ? String(replacement) : match;
    });
  }
}

export const i18n = new I18nService();
