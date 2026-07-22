/**
 * Steering support (Pi-style): the user can keep typing while the agent
 * works. Messages land in a SteeringQueue owned by the active run:
 *
 *  - drained after each tool batch → injected as extra text on the
 *    tool-result user message (the backend already orders tool_result blocks
 *    before text blocks, so this is wire-correct with zero backend change);
 *  - drained again when the turn would end → promoted to a full follow-up
 *    user turn (fresh <project_state> snapshot + checkpoint) and the loop
 *    continues.
 *
 * The queue is intentionally dumb — ordering, promotion, and events are the
 * runner's job (AgentRunner.runTurn), UI bubbles are the store's.
 */

export class SteeringQueue {
  private items: string[] = [];

  push(text: string): void {
    this.items.push(text);
  }

  /** Remove one queued item by index (the ✕ on the pending chip). */
  removeAt(index: number): void {
    this.items.splice(index, 1);
  }

  drain(): string[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  /** Copy of the currently queued texts (for the pending-chips UI). */
  snapshot(): string[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }
}
