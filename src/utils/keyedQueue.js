/** Serialises async work per key (e.g. per WhatsApp number) so one user's events never interleave. */
export class KeyedQueue {
  #tails = new Map();

  run(key, fn) {
    const prev = this.#tails.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.#tails.set(key, next);
    const cleanup = () => { if (this.#tails.get(key) === next) this.#tails.delete(key); };
    next.then(cleanup, cleanup);
    return next;
  }

  async drain() {
    while (this.#tails.size) await Promise.all([...this.#tails.values()].map((p) => p.catch(() => {})));
  }
}
