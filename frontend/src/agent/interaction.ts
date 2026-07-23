/**
 * Programmatic component interaction for the AI assistant.
 *
 * Drives the SAME input paths the student's mouse does — button elements get
 * `button-press`/`button-release` events (the part simulations listen for
 * exactly these), potentiometers get `value` + `input`/`change` events, and
 * sensors go through dispatchSensorUpdate() like the SensorControlPanel.
 *
 * One call = stimulus + response: after acting it observes the simulation
 * briefly and reports a before → after diff, so the model can verify
 * input→output contracts ("button toggles LED", "temp > 30 sounds alarm")
 * in a single tool call.
 */

import { useSimulatorStore } from '../store/useSimulatorStore';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { SENSOR_CONTROLS } from '../simulation/sensorControlConfig';
import { observeSimulation, snapshotOutputs, diffSnapshots, MAX_OBSERVE_MS } from './observation';

export type InteractAction = 'click' | 'press' | 'release' | 'set_value' | 'set_sensor';

export interface InteractInput {
  componentId: string;
  action: InteractAction;
  value?: number;
  values?: Record<string, number | boolean>;
  holdMs?: number;
  observeMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function getMountedEl(id: string): HTMLElement & Record<string, unknown> {
  const el =
    typeof document !== 'undefined'
      ? (document.getElementById(id) as (HTMLElement & Record<string, unknown>) | null)
      : null;
  if (!el) {
    throw new Error(`Component "${id}" is not mounted on the canvas (element not found).`);
  }
  return el;
}

function sensorKeys(metadataId: string): string[] {
  const def = SENSOR_CONTROLS[metadataId];
  return def ? def.controls.map((c) => c.key) : [];
}

/** Execute an interaction; throws descriptive errors for the tool layer. */
export async function interact(input: InteractInput): Promise<string> {
  const sim = useSimulatorStore.getState();
  const component = sim.components.find((c) => c.id === input.componentId);
  if (!component) {
    const ids = sim.components.map((c) => c.id).join(', ') || '(none)';
    throw new Error(`Component "${input.componentId}" not found. Components on canvas: ${ids}`);
  }

  const anyRunning = sim.boards.some((b) => b.running);
  const holdMs = Math.max(50, Math.min(3000, input.holdMs ?? 300));
  const observeMs = Math.max(0, Math.min(MAX_OBSERVE_MS, input.observeMs ?? 800));

  const before = snapshotOutputs();
  let actionNote: string;

  switch (input.action) {
    case 'press': {
      const el = getMountedEl(component.id);
      el.pressed = true;
      el.dispatchEvent(new Event('button-press'));
      actionNote = `Pressed (and held) "${component.id}". Call {action: "release"} to let go.`;
      break;
    }
    case 'release': {
      const el = getMountedEl(component.id);
      el.pressed = false;
      el.dispatchEvent(new Event('button-release'));
      actionNote = `Released "${component.id}".`;
      break;
    }
    case 'click': {
      const el = getMountedEl(component.id);
      el.pressed = true;
      el.dispatchEvent(new Event('button-press'));
      await sleep(holdMs);
      el.pressed = false;
      el.dispatchEvent(new Event('button-release'));
      actionNote = `Clicked "${component.id}" (held ${holdMs}ms — long enough to beat debounce).`;
      break;
    }
    case 'set_value': {
      if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
        throw new Error('set_value requires a numeric "value".');
      }
      const el = getMountedEl(component.id);
      el.value = input.value;
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
      actionNote = `Set "${component.id}" value to ${input.value}.`;
      break;
    }
    case 'set_sensor': {
      const def = SENSOR_CONTROLS[component.metadataId];
      if (!def) {
        const capable = Object.keys(SENSOR_CONTROLS).join(', ');
        throw new Error(
          `"${component.id}" (${component.metadataId}) has no interactive sensor values. ` +
            `Sensor-capable types: ${capable}`,
        );
      }
      if (!input.values || typeof input.values !== 'object' || Object.keys(input.values).length === 0) {
        throw new Error(
          `set_sensor requires "values", e.g. {"${sensorKeys(component.metadataId)[0]}": 35}. ` +
            `Valid keys for ${component.metadataId}: ${sensorKeys(component.metadataId).join(', ')}`,
        );
      }
      const valid = new Set(sensorKeys(component.metadataId));
      const unknown = Object.keys(input.values).filter((k) => !valid.has(k));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown sensor key(s) ${unknown.join(', ')} for ${component.metadataId}. ` +
            `Valid keys: ${[...valid].join(', ')}`,
        );
      }
      dispatchSensorUpdate(component.id, input.values);
      actionNote =
        `Set ${component.metadataId} "${component.id}" to ` +
        `${JSON.stringify(input.values)}.` +
        (anyRunning
          ? ''
          : ' NOTE: the simulation is not running — start it with run_simulation, then set the value again.');
      break;
    }
    default:
      throw new Error(
        `Unknown action "${String(input.action)}". Use click | press | release | set_value | set_sensor.`,
      );
  }

  // Observe the response window, then diff outputs.
  const report = observeMs > 0 && anyRunning ? await observeSimulation({ durationMs: observeMs }) : '';
  const after = snapshotOutputs();
  const changes = diffSnapshots(before, after);

  const changeLines =
    changes.length > 0
      ? `CHANGES (before → after):\n${changes.map((l) => `- ${l}`).join('\n')}`
      : '(no observable output change after the action)';

  return [actionNote, changeLines, report].filter(Boolean).join('\n\n');
}
