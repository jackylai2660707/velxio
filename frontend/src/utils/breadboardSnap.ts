/**
 * Parts-on-breadboard support (Wokwi-style).
 *
 * Model (mirrors what Wokwi persists as `["r1:1","bb1:6t.b","",["$bb"]]`):
 * a part seated on a breadboard is connected by one INVISIBLE zero-length
 * wire per pin, from the part pin to the hole under it. Those wires are
 * ordinary `Wire` objects flagged `bb: true`, so the netlist builder, the
 * digital trace and SPICE treat them exactly like hand-drawn wires — the
 * only special-casing is cosmetic (not rendered, not hit-testable).
 *
 * Two building blocks live here:
 *  - pure geometry over the exported hole grids (testable without DOM), and
 *  - a DOM adapter that reads the dragged part's pinInfo to compute the
 *    anchor-pin snap and the per-pin seating.
 */

import {
  BREADBOARD_PINS,
} from '../velxio-elements/breadboard-element';
import {
  BREADBOARD_MINI_PINS,
} from '../velxio-elements/breadboard-mini-element';
import { isBreadboard } from './breadboardNets';
import { calculatePinPosition } from './pinPositionCalculator';

export interface Hole {
  name: string;
  x: number; // element-space CSS px (relative to the breadboard inner element)
  y: number;
}

interface Pt {
  x: number;
  y: number;
}

export interface ComponentLike {
  id: string;
  metadataId: string;
  x: number;
  y: number;
  properties?: Record<string, unknown>;
}

/** Magnet range for the anchor pin while dragging (px, world units). */
export const SNAP_TOLERANCE = 9;
/**
 * A pin within this of a hole center counts as plugged in. Must absorb the
 * worst element-geometry residual (~1.6 px — pin spacings are not exact
 * 9.6 multiples) while staying below half the hole pitch (4.8 px) so a
 * pin can never be ambiguous between two holes.
 */
export const SEAT_TOLERANCE = 4;

/** DynamicComponent wrapper inset: border 2 + padding 4 on every side. */
const WRAPPER_INSET = 6;

export function breadboardHoles(metadataId: string): readonly Hole[] | null {
  if (metadataId === 'breadboard') return BREADBOARD_PINS;
  if (metadataId === 'breadboard-mini') return BREADBOARD_MINI_PINS;
  return null;
}

/**
 * Nearest hole of one breadboard to a world point. Pure — hole world
 * position is bb top-left + wrapper inset + element-space hole coords.
 * Rotated breadboards are not supported (returns null).
 */
export function nearestHole(
  bb: ComponentLike,
  world: Pt,
  maxDistance: number,
): { name: string; x: number; y: number; dist: number } | null {
  if (Number(bb.properties?.rotation) || 0) return null;
  const holes = breadboardHoles(bb.metadataId);
  if (!holes) return null;
  const ox = bb.x + WRAPPER_INSET;
  const oy = bb.y + WRAPPER_INSET;
  let best: { name: string; x: number; y: number; dist: number } | null = null;
  for (const h of holes) {
    const hx = ox + h.x;
    const hy = oy + h.y;
    const dist = Math.hypot(hx - world.x, hy - world.y);
    if (dist <= maxDistance && (!best || dist < best.dist)) {
      best = { name: h.name, x: hx, y: hy, dist };
    }
  }
  return best;
}

function breadboardsOf(components: ComponentLike[]): ComponentLike[] {
  return components.filter((c) => isBreadboard(c.metadataId));
}

/** Pin names of a mounted component, from its DOM element's pinInfo. */
function pinNames(componentId: string): string[] | null {
  const el = document.getElementById(componentId);
  const pinInfo = el && (el as { pinInfo?: Array<{ name: string }> }).pinInfo;
  if (!pinInfo || !Array.isArray(pinInfo) || pinInfo.length === 0) return null;
  return pinInfo.map((p) => p.name);
}

/**
 * Snap a dragged component's tentative position so its ANCHOR pin (first
 * pinInfo entry) lands exactly on the nearest hole center. Returns the
 * adjusted {x, y} or null when no hole is within SNAP_TOLERANCE (or the
 * geometry cannot be measured).
 */
export function snapPositionToBreadboard(
  comp: ComponentLike,
  tentativeX: number,
  tentativeY: number,
  components: ComponentLike[],
): Pt | null {
  if (isBreadboard(comp.metadataId)) return null;
  const bbs = breadboardsOf(components);
  if (bbs.length === 0) return null;
  const names = pinNames(comp.id);
  if (!names) return null;
  const rotation = Number(comp.properties?.rotation) || 0;
  const anchor = calculatePinPosition(
    comp.id, names[0], tentativeX + WRAPPER_INSET, tentativeY + WRAPPER_INSET, rotation,
  );
  if (!anchor) return null;
  let best: { hole: { x: number; y: number; dist: number }; } | null = null;
  for (const bb of bbs) {
    const hole = nearestHole(bb, anchor, SNAP_TOLERANCE);
    if (hole && (!best || hole.dist < best.hole.dist)) best = { hole };
  }
  if (!best) return null;
  return {
    x: tentativeX + (best.hole.x - anchor.x),
    y: tentativeY + (best.hole.y - anchor.y),
  };
}

export interface Seat {
  pinName: string;
  pinX: number;
  pinY: number;
  bbId: string;
  holeName: string;
  holeX: number;
  holeY: number;
}

/**
 * Compute the per-pin seating of a component at its CURRENT position:
 * every pin within SEAT_TOLERANCE of a hole. Returns null when geometry
 * cannot be measured (unmounted DOM) — callers must then leave any
 * existing seating untouched; an empty array means "measured, not seated".
 */
export function computeSeating(
  comp: ComponentLike,
  components: ComponentLike[],
): Seat[] | null {
  if (isBreadboard(comp.metadataId)) return [];
  const bbs = breadboardsOf(components);
  if (bbs.length === 0) return [];
  const names = pinNames(comp.id);
  if (!names) return null;
  const rotation = Number(comp.properties?.rotation) || 0;
  const seats: Seat[] = [];
  for (const name of names) {
    const pin = calculatePinPosition(
      comp.id, name, comp.x + WRAPPER_INSET, comp.y + WRAPPER_INSET, rotation,
    );
    if (!pin) continue;
    let best: { bbId: string; hole: { name: string; x: number; y: number; dist: number } } | null =
      null;
    for (const bb of bbs) {
      const hole = nearestHole(bb, pin, SEAT_TOLERANCE);
      if (hole && (!best || hole.dist < best.hole.dist)) best = { bbId: bb.id, hole };
    }
    if (best) {
      seats.push({
        pinName: name,
        pinX: pin.x,
        pinY: pin.y,
        bbId: best.bbId,
        holeName: best.hole.name,
        holeX: best.hole.x,
        holeY: best.hole.y,
      });
    }
  }
  return seats;
}

/**
 * True when the component's bounding-box center is over a breadboard's
 * body — used to auto-rotate axial parts (resistors) to vertical so they
 * bridge the center trench like on a real board.
 */
export function isOverBreadboard(
  comp: ComponentLike,
  tentativeX: number,
  tentativeY: number,
  components: ComponentLike[],
): boolean {
  const el = document.getElementById(comp.id);
  const w = el ? (el as HTMLElement).offsetWidth : 40;
  const h = el ? (el as HTMLElement).offsetHeight : 40;
  const cx = tentativeX + WRAPPER_INSET + w / 2;
  const cy = tentativeY + WRAPPER_INSET + h / 2;
  for (const bb of breadboardsOf(components)) {
    const bbEl = document.getElementById(bb.id);
    if (!bbEl) continue;
    const bw = (bbEl as HTMLElement).offsetWidth;
    const bh = (bbEl as HTMLElement).offsetHeight;
    if (
      cx >= bb.x + WRAPPER_INSET && cx <= bb.x + WRAPPER_INSET + bw &&
      cy >= bb.y + WRAPPER_INSET && cy <= bb.y + WRAPPER_INSET + bh
    ) {
      return true;
    }
  }
  return false;
}

/** Axial 2-pin parts that read better vertical on a breadboard: 'resistor'
 * plus every preconfigured 'resistor-<value>' variant. */
export function isAutoVerticalPart(metadataId: string): boolean {
  return metadataId.startsWith('resistor') || metadataId.startsWith('wokwi-resistor');
}
