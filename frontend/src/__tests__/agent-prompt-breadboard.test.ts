/**
 * Prompt contract for beginner-friendly breadboard layouts.
 *
 * These checks intentionally assert the electrical/layout rules, not exact
 * prose.  A prompt regression here otherwise brings back the common failure
 * mode where an agent puts every jumper through terminal strips, stacks a
 * resistor under an LED, and leaves the long power rails unused.
 */
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT } from '../agent/systemPrompt';

describe('agent prompt — breadboard layout contract', () => {
  it('instructs the agent to use long positive/negative rails for distribution', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    // Mention both rail polarity and the physical rail naming convention.
    expect(prompt).toMatch(/power rail/);
    expect(prompt).toMatch(/red/);
    expect(prompt).toMatch(/ground|negative/);
    expect(prompt).toMatch(/tp\.|bp\.|tn\.|bn\.|positive rail|negative rail/);
  });

  it('requires readable spacing and forbids stacking series parts', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toMatch(/(adjacent|separate|distinct).{0,80}(row|column|strip|space)/);
    expect(prompt).toMatch(/(overlap|stack|on top|spaghetti)/);
    expect(prompt).toMatch(/resistor/);
    expect(prompt).toMatch(/led/);
  });

  it('keeps breadboard rail/strip semantics explicit', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain('breadboard');
    expect(prompt).toMatch(/(seat|place).{0,100}(distinct|different).{0,100}(strip|rail|hole)/);
    expect(prompt).toMatch(/(rail|hole).{0,100}(component leg|pin)/);
  });
});

