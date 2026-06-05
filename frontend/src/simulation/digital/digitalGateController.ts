/**
 * digitalGateController — Phase 2 of project/digital-gate-engine/.
 *
 * Mounts the digital gate engine into the live app: when `?digitalgates=on` and
 * the board-less circuit is all-digital, it builds the network from the store on
 * every relevant change (switch toggle / load), settles it on the multichip-bus
 * kernel, and pushes the resolved levels onto the real `wokwi-led` DOM elements.
 * ngspice is told to skip all-digital circuits (CircuitSimulationService guard)
 * so the two motors do not fight over the LEDs.
 *
 * Flag OFF (default) => this is a no-op and nothing changes. Mixed / analog
 * circuits never qualify as all-digital, so they stay entirely on ngspice.
 */
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { PinManager } from '../PinManager';
import { resetBusNets } from '../customChips/busNets';
import { buildDigitalNetwork, digitalGatesEnabled, isAllDigital } from './digitalGateEngine';
import { PROPERTY_CHANGE_EVENT } from '../parts/partUtils';

interface LedEl extends HTMLElement {
  value?: boolean;
  brightness?: number;
}

/**
 * Start the controller. Returns an unsubscribe handle. Safe to call when the
 * flag is off — it returns a no-op disposer immediately.
 */
export function mountDigitalGateEngine(): () => void {
  if (typeof window === 'undefined' || !digitalGatesEnabled()) return () => {};

  let disposed = false;
  let raf = 0;

  const paintLeds = () => {
    const st = useSimulatorStore.getState();
    // Mixed / analog circuits belong to ngspice — leave them alone.
    if (!isAllDigital(st.components as never[])) return;
    resetBusNets();
    const net = buildDigitalNetwork(st.components as never[], st.wires as never[], new PinManager());
    if (!net.ok) return;
    for (const id of net.ledIds) {
      const el = document.getElementById(id) as LedEl | null;
      if (!el) continue;
      const lit = net.readLed(id) === 1;
      el.value = lit;
      el.brightness = lit ? 1 : 0;
    }
  };

  // Coalesce bursts (e.g. loadExample sets many components) into one paint.
  const schedule = () => {
    if (disposed || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!disposed) paintLeds();
    });
  };

  // Switch toggles emit velxio:property-change; structural changes bump the
  // store's components/wires references.
  const onProp = () => schedule();
  window.addEventListener(PROPERTY_CHANGE_EVENT, onProp);
  const unsub = useSimulatorStore.subscribe((n, p) => {
    if (n.components !== p.components || n.wires !== p.wires) schedule();
  });

  schedule(); // initial paint

  return () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener(PROPERTY_CHANGE_EVENT, onProp);
    unsub();
  };
}
