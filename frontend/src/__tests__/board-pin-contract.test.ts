import { describe, expect, it } from 'vitest';
import {
  formatPinContract,
  getBoardPinContract,
  resolvePinContract,
  validatePinUse,
} from '../agent/boardPinContract';

describe('board pin contracts', () => {
  it('describes classic ESP32 electrical hazards and aliases', () => {
    const tx = resolvePinContract('esp32', 'TX');
    expect(tx).toMatchObject({ gpio: 1, exposed: true, voltage: 3.3 });
    expect(tx?.protocols).toContain('uart0-tx');

    const inputOnly = resolvePinContract('esp32', 'GPIO34');
    expect(inputOnly).toMatchObject({ gpio: 34, inputOnly: true, exposed: true });
    expect(inputOnly?.notes.join(' ')).toContain('input-only');
    expect(inputOnly?.protocols).not.toContain('pwm-ledc');

    const flash = resolvePinContract('esp32', '6');
    expect(flash).toMatchObject({ gpio: 6, reserved: true, exposed: false });

    const strap = resolvePinContract('esp32', '12');
    expect(strap?.strap).toBe(true);
    expect(strap?.notes.join(' ')).toContain('flash voltage');

    expect(resolvePinContract('esp32', 'GND.2')?.powerRole).toBe('gnd');
    expect(resolvePinContract('esp32', '3V3.1')?.voltage).toBe(3.3);
  });

  it('distinguishes S3 and C3 contracts instead of applying classic GPIO assumptions', () => {
    const s3Tx = resolvePinContract('esp32-s3', 'TX');
    expect(s3Tx).toMatchObject({ gpio: 43, exposed: true });
    expect(s3Tx?.protocols).toContain('uart0-tx');

    const s3Input = resolvePinContract('esp32-s3', '46');
    expect(s3Input).toMatchObject({ inputOnly: true, strap: true, exposed: true });

    const c3Tx = resolvePinContract('esp32-c3', 'TX');
    expect(c3Tx).toMatchObject({ gpio: 21, exposed: true });
    expect(resolvePinContract('esp32-c3', 'GPIO18')).toMatchObject({ reserved: true });
    expect(resolvePinContract('xiao-esp32-c3', 'D6')?.gpio).toBe(21);
    expect(resolvePinContract('arduino-nano-esp32', 'RX0')).toMatchObject({
      gpio: 44,
      voltage: 3.3,
    });
    expect(resolvePinContract('arduino-nano-esp32', 'D13')?.gpio).toBe(48);
  });

  it('captures Arduino and Pico voltage/protocol/input contracts', () => {
    expect(resolvePinContract('arduino-uno', 'A4')).toMatchObject({
      gpio: 18,
      voltage: 5,
      inputOnly: false,
    });
    expect(resolvePinContract('arduino-uno', 'A4')?.protocols).toContain('i2c0-sda');
    expect(resolvePinContract('arduino-uno', '2')?.protocols).not.toContain('pwm');
    expect(resolvePinContract('arduino-uno', '3')?.protocols).toContain('pwm');
    expect(resolvePinContract('arduino-nano', 'A6')).toMatchObject({ inputOnly: true, gpio: 20 });
    expect(resolvePinContract('arduino-mega', 'TX1')?.protocols).toContain('uart1-tx');

    const picoAdc = resolvePinContract('raspberry-pi-pico', 'A0');
    expect(picoAdc).toMatchObject({ gpio: 26, inputOnly: false, voltage: 3.3 });
    expect(picoAdc?.protocols).toContain('adc');
    expect(resolvePinContract('pi-pico-w', 'GP4')?.protocols).toContain('i2c0-sda');
    expect(resolvePinContract('raspberry-pi-pico', 'GP23')).toMatchObject({
      exposed: false,
      reserved: true,
    });
    expect(resolvePinContract('raspberry-pi-pico', 'VBUS')).toMatchObject({
      powerRole: '5v',
      voltage: 5,
      inputOnly: true,
    });
  });

  it('fails closed for unknown, hidden, reserved and output-incompatible pins', () => {
    const unknown = validatePinUse('esp32', 'GPIO99', 'output');
    expect(unknown.ok).toBe(false);
    expect(unknown.pin).toBeNull();
    expect(unknown.errors[0]).toContain('do not guess');

    const inputOnly = validatePinUse('esp32', '34', 'output');
    expect(inputOnly.ok).toBe(false);
    expect(inputOnly.errors.join(' ')).toContain('input-only');

    const reserved = validatePinUse('esp32', '6', 'wire');
    expect(reserved.ok).toBe(false);
    expect(reserved.errors.join(' ')).toContain('not exposed');
    expect(reserved.errors.join(' ')).toContain('reserved');

    const wrongVoltage = validatePinUse('esp32', '13', 'wire', 5);
    expect(wrongVoltage.ok).toBe(false);
    expect(wrongVoltage.errors.join(' ')).toContain('3.3V');

    const strap = validatePinUse('esp32', '0', 'wire');
    expect(strap.ok).toBe(true);
    expect(strap.warnings.join(' ')).toContain('strapping');
  });

  it('returns defensive copies and a compact agent-readable description', () => {
    const first = getBoardPinContract('esp32');
    const gpio13 = first.find((pin) => pin.gpio === 13)!;
    (gpio13.aliases as unknown as string[]).push('MUTATED');
    (gpio13.notes as unknown as string[]).push('MUTATED');
    const second = resolvePinContract('esp32', '13')!;
    expect(second.aliases).not.toContain('MUTATED');
    expect(second.notes).not.toContain('MUTATED');

    const text = formatPinContract(resolvePinContract('esp32', 'GPIO34')!);
    expect(text).toContain('gpio=34');
    expect(text).toContain('exposed');
    expect(text).toContain('input-only');
    expect(text).toContain('3.3V');
  });
});
