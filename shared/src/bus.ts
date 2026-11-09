// A typed event bus. The event names and the payload of each one are one type
// (`E`), so `on("hit", ...)` knows what the handler receives and `emit` refuses
// a payload of the wrong shape. No DOM, so it also runs in the server and in tests.
export class Bus<E extends object> {
  #handlers: { [K in keyof E]?: Set<(detail: E[K]) => void> } = {};

  // returns the function that removes the handler again
  on<K extends keyof E>(type: K, handler: (detail: E[K]) => void): () => void {
    const set = this.#handlers[type] ?? new Set();
    set.add(handler);
    this.#handlers[type] = set;
    return () => {
      set.delete(handler);
    };
  }

  emit<K extends keyof E>(type: K, detail: E[K]): void {
    const set = this.#handlers[type];
    if (!set) return;
    for (const handler of [...set]) handler(detail);
  }
}
