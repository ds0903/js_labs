import { isTypingTarget } from "./dom.ts";

export interface Input {
  isDown(code: string): boolean;
  // true from the key press until the end of the next simulation step
  justPressed(code: string): boolean;
  // call handler on every fresh key press, returns a function that removes it
  onPress(code: string, handler: (event: KeyboardEvent) => void): () => void;
  endStep(): void;
  dispose(): void;
}

// what a game needs from its input; a scripted scenario can provide it too
export type KeyState = Pick<Input, "isDown" | "justPressed" | "endStep">;

type KeyTarget = Pick<Window, "addEventListener" | "removeEventListener">;

// Keyboard state lives in the closure: nothing outside can touch `down` or
// `pressed`, the only way in is through the returned functions.
export function createInput(target: KeyTarget = window): Input {
  const down = new Set<string>();
  const pressed = new Set<string>();
  const handlers = new Map<string, Set<(event: KeyboardEvent) => void>>();

  function onKeyDown(event: KeyboardEvent) {
    // keys typed into the chat line or the lobby form are not game input
    if (isTypingTarget(event.target)) return;
    if (!down.has(event.code)) pressed.add(event.code);
    down.add(event.code);
    if (!event.repeat) {
      // plain call: `this` inside a handler is undefined, not the object
      // the method belongs to
      for (const handler of handlers.get(event.code) ?? []) handler(event);
    }
    if (event.code.startsWith("Arrow") || event.code === "Space") event.preventDefault();
  }

  function onKeyUp(event: KeyboardEvent) {
    down.delete(event.code);
  }

  // keyup is never delivered if the window lost focus while a key was held
  function onBlur() {
    down.clear();
  }

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    onPress(code, handler) {
      const set = handlers.get(code) ?? new Set();
      set.add(handler);
      handlers.set(code, set);
      return () => {
        set.delete(handler);
      };
    },
    endStep() {
      pressed.clear();
    },
    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    },
  };
}
