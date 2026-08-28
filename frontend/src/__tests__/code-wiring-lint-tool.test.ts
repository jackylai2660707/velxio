import { describe, expect, it } from 'vitest';
import { executeTool, TOOL_DEFINITIONS } from '../agent/tools';

describe('lint_code_wiring agent tool', () => {
  it('is advertised as a read-only board-aware tool', () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'lint_code_wiring');
    expect(definition).toBeDefined();
    expect(definition?.description).toContain('never mutates');
    expect(definition?.input_schema.properties.board_id).toBeDefined();
  });

  it('returns a current-state lint report without mutating the canvas', async () => {
    const before = await executeTool('get_project', {});
    const lint = await executeTool('lint_code_wiring', {});
    const after = await executeTool('get_project', {});
    expect(lint.isError).toBe(false);
    expect(lint.result).toContain('CODE↔WIRING LINT');
    expect(after.result).toBe(before.result);
  });
});
