/**
 * Bridge between the AI assistant and the editor toolbar.
 *
 * The toolbar's Compile / Run / Stop handlers carry all the per-board logic
 * (custom-chip WASM prep, MicroPython load, ESP32 build options, QEMU start,
 * pre-flight circuit checks). Rather than duplicating any of that, the
 * toolbar registers its handlers here and the agent's compile/run tools call
 * through — so an agent-triggered compile behaves exactly like clicking the
 * button.
 */

export interface ToolbarActions {
  compile: () => Promise<void>;
  run: () => Promise<void>;
  stop: () => void;
}

let actions: ToolbarActions | null = null;

/** Called by EditorToolbar on mount. Returns an unregister function. */
export function registerToolbarActions(a: ToolbarActions): () => void {
  actions = a;
  return () => {
    if (actions === a) actions = null;
  };
}

export function getToolbarActions(): ToolbarActions | null {
  return actions;
}
