export class RendererDeliveryGate<T> {
  private ready = false;
  private pending: T | null = null;

  get isReady(): boolean {
    return this.ready;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  enqueue(value: T): void {
    this.pending = value;
  }

  startLoading(): void {
    this.ready = false;
  }

  finishLoading(): void {
    this.ready = true;
  }

  tryDeliver(deliver: (value: T) => boolean): boolean {
    if (!this.ready || this.pending === null) return false;
    const value = this.pending;
    if (!deliver(value)) return false;
    if (this.pending === value) this.pending = null;
    return true;
  }
}
