// Node 22+ predefines globalThis.localStorage/sessionStorage (disabled unless the process is
// started with --localstorage-file). Vitest's jsdom environment only copies a jsdom global onto
// globalThis when that key is missing there already or explicitly allow-listed -- and
// "localStorage"/"sessionStorage" are neither, so jsdom's own working Storage never replaces
// Node's disabled one. A minimal in-memory polyfill sidesteps that gap entirely.
class MemoryStorage implements Storage {
  private readonly _data = new Map<string, string>();

  public get length(): number {
    return this._data.size;
  }

  public key(index: number): string | null {
    return Array.from(this._data.keys())[index] ?? null;
  }

  public getItem(key: string): string | null {
    return this._data.has(key) ? this._data.get(key)! : null;
  }

  public setItem(key: string, value: string): void {
    this._data.set(key, String(value));
  }

  public removeItem(key: string): void {
    this._data.delete(key);
  }

  public clear(): void {
    this._data.clear();
  }
}

if (typeof window !== "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
