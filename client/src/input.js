// Keyboard state lives in the closure: nothing outside can touch `down` or
// `pressed`, the only way in is through the returned functions.
export function createInput(target = window) {
  const down = new Set();
  const pressed = new Set();
  const handlers = new Map(); // code -> Set of functions

  function onKeyDown(event) {
    if (!down.has(event.code)) pressed.add(event.code);
    down.add(event.code);
    if (!event.repeat) {
      // plain call: `this` inside a handler is undefined, not the object
      // the method belongs to
      for (const handler of handlers.get(event.code) ?? []) handler(event);
    }
    if (event.code.startsWith("Arrow") || event.code === "Space") event.preventDefault();
  }

  function onKeyUp(event) {
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
    // true from the key press until the end of the next simulation step
    justPressed: (code) => pressed.has(code),
    // call handler on every fresh key press, returns a function that removes it
    onPress(code, handler) {
      if (!handlers.has(code)) handlers.set(code, new Set());
      handlers.get(code).add(handler);
      return () => handlers.get(code).delete(handler);
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
