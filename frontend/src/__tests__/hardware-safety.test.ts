import { describe, expect, it } from 'vitest';
import { analyzeHardwareSafety } from '../agent/hardwareSafety';

const wire = (a: string, ap: string, b: string, bp: string) => ({
  start: { componentId: a, pinName: ap }, end: { componentId: b, pinName: bp },
});

describe('hardware safety graph checks', () => {
  it('blocks a 5V rail reaching an ESP32 GPIO', () => {
    const issues = analyzeHardwareSafety({
      boards: [{ id: 'esp', boardKind: 'esp32' }], components: [],
      wires: [wire('esp', '5V', 'esp', '21')],
    });
    expect(issues.some((i) => i.code === 'gpio-overvoltage' && i.severity === 'error')).toBe(true);
  });

  it('flags two MCU outputs on one net', () => {
    const issues = analyzeHardwareSafety({
      boards: [{ id: 'a', boardKind: 'arduino-uno' }, { id: 'b', boardKind: 'esp32' }], components: [],
      wires: [wire('a', '13', 'b', '21')],
    });
    expect(issues.some((i) => i.code === 'gpio-contention')).toBe(true);
  });

  it('flags HC-SR04 Echo level shifting on ESP32', () => {
    const issues = analyzeHardwareSafety({
      boards: [{ id: 'esp', boardKind: 'esp32' }],
      components: [{ id: 'sonar', metadataId: 'hc-sr04' }],
      wires: [wire('sonar', 'ECHO', 'esp', '21')],
    });
    expect(issues.some((i) => i.code === 'level-shift-required')).toBe(true);
  });

  it('warns when a connected board has no common ground', () => {
    const issues = analyzeHardwareSafety({
      boards: [{ id: 'uno', boardKind: 'arduino-uno' }], components: [],
      wires: [wire('uno', '13', 'uno', '12')],
    });
    expect(issues.some((i) => i.code === 'missing-common-ground')).toBe(true);
  });
});

