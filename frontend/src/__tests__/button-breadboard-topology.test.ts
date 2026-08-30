// @vitest-environment jsdom
/**
 * Physical topology contract for Wokwi's four-pin tactile pushbuttons.
 *
 * A tactile button is not a four-independent-pin component: 1.l/1.r are
 * one contact and 2.l/2.r are the other contact.  When the part is mounted
 * on a full breadboard it must be rotated so each contact pair crosses the
 * centre trench.  These tests deliberately enumerate the legal placements
 * and the common tempting-but-wrong placements so a prompt/tool regression
 * cannot silently put the whole switch in one terminal strip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BREADBOARD_PINS,
} from '../velxio-elements/breadboard-element';
import {
  computeSeating,
  solvePlacement,
  validateTactileButtonSeating,
  type PinOffset,
} from '../utils/breadboardSnap';
import { calculatePinPosition } from '../utils/pinPositionCalculator';
import { executeTool } from '../agent/tools';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { SYSTEM_PROMPT } from '../agent/systemPrompt';

const FULL_ROW_PARTNER: Record<'a' | 'b' | 'c' | 'd' | 'e', 'f' | 'g' | 'h' | 'i' | 'j'> = {
  a: 'f',
  b: 'g',
  c: 'h',
  d: 'i',
  e: 'j',
};

const FULL_ROW_TOP = Object.keys(FULL_ROW_PARTNER) as Array<keyof typeof FULL_ROW_PARTNER>;

type Bank = 't' | 'b';

/** Build a valid seat map for one contact row.  `leftBank` mirrors 90°/270°
 * mounting: either .l is on top and .r on bottom, or vice versa. */
function validFullSeats(
  row: keyof typeof FULL_ROW_PARTNER,
  leftBank: Bank = 't',
  firstColumn = 10,
  secondColumn = 12,
) {
  const partner = FULL_ROW_PARTNER[row];
  if (leftBank === 't') {
    return [
      { pinName: '1.l', holeName: `${firstColumn}t.${row}` },
      { pinName: '2.l', holeName: `${secondColumn}t.${row}` },
      { pinName: '1.r', holeName: `${firstColumn}b.${partner}` },
      { pinName: '2.r', holeName: `${secondColumn}b.${partner}` },
    ];
  }
  return [
    { pinName: '1.l', holeName: `${firstColumn}b.${partner}` },
    { pinName: '2.l', holeName: `${secondColumn}b.${partner}` },
    { pinName: '1.r', holeName: `${firstColumn}t.${row}` },
    { pinName: '2.r', holeName: `${secondColumn}t.${row}` },
  ];
}

describe('tactile button seating topology', () => {
  it('prompt makes seating and terminal selection a hard prerequisite for wiring', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain('call seat_component for every part');
    expect(prompt).toMatch(/after seat_component.{0,180}terminal[_-]1\.connection_hole/);
    expect(prompt).toMatch(/terminal[_-]2\.connection_hole/);
    expect(prompt).toMatch(/never wire directly to a seated leg/);
    expect(prompt).toMatch(/gpio and gnd must never use the same numbered terminal/);
  });

  it.each(FULL_ROW_TOP)('accepts full-size row %s crossing the trench', (row) => {
    expect(validateTactileButtonSeating('pushbutton', validFullSeats(row))).toBeNull();
  });

  it.each(FULL_ROW_TOP)('accepts mirrored full-size row %s (270° orientation)', (row) => {
    expect(validateTactileButtonSeating('pushbutton', validFullSeats(row, 'b'))).toBeNull();
  });

  it('accepts a 6mm button only when both contacts bridge e↔f', () => {
    expect(validateTactileButtonSeating('pushbutton-6mm', [
      { pinName: '1.l', holeName: '10t.e' },
      { pinName: '2.l', holeName: '12t.e' },
      { pinName: '1.r', holeName: '10b.f' },
      { pinName: '2.r', holeName: '12b.f' },
    ])).toBeNull();
    expect(validateTactileButtonSeating('pushbutton-6mm', [
      { pinName: '1.l', holeName: '10b.f' },
      { pinName: '2.l', holeName: '12b.f' },
      { pinName: '1.r', holeName: '10t.e' },
      { pinName: '2.r', holeName: '12t.e' },
    ])).toBeNull();
  });

  it.each([
    ['all four legs in the top bank', [
      { pinName: '1.l', holeName: '10t.e' },
      { pinName: '2.l', holeName: '12t.e' },
      { pinName: '1.r', holeName: '10t.a' },
      { pinName: '2.r', holeName: '12t.a' },
    ]],
    ['all four legs in the bottom bank', [
      { pinName: '1.l', holeName: '10b.j' },
      { pinName: '2.l', holeName: '12b.j' },
      { pinName: '1.r', holeName: '10b.f' },
      { pinName: '2.r', holeName: '12b.f' },
    ]],
    ['a mismatched row pair', [
      { pinName: '1.l', holeName: '10t.a' },
      { pinName: '2.l', holeName: '12t.e' },
      { pinName: '1.r', holeName: '10b.g' },
      { pinName: '2.r', holeName: '12b.j' },
    ]],
    ['a pair that does not align in one column', [
      { pinName: '1.l', holeName: '10t.e' },
      { pinName: '2.l', holeName: '12t.e' },
      { pinName: '1.r', holeName: '11b.j' },
      { pinName: '2.r', holeName: '12b.j' },
    ]],
    ['both contact terminals in one numbered column', [
      { pinName: '1.l', holeName: '10t.e' },
      { pinName: '2.l', holeName: '10t.d' },
      { pinName: '1.r', holeName: '10b.j' },
      { pinName: '2.r', holeName: '10b.i' },
    ]],
    ['a rail used as a leg anchor', [
      { pinName: '1.l', holeName: 'tp.10' },
      { pinName: '2.l', holeName: '12t.e' },
      { pinName: '1.r', holeName: '10b.j' },
      { pinName: '2.r', holeName: '12b.j' },
    ]],
  ] as Array<[string, Array<{ pinName: string; holeName: string }>]>)(
    'rejects %s',
    (_name, seats) => {
      expect(validateTactileButtonSeating('pushbutton', seats)).not.toBeNull();
    },
  );

  it('rejects incomplete pin maps instead of validating a partial switch', () => {
    expect(validateTactileButtonSeating('pushbutton', [
      { pinName: '1.l', holeName: '10t.e' },
      { pinName: '2.l', holeName: '12t.e' },
      { pinName: '1.r', holeName: '10b.j' },
    ])).toMatch(/all four/i);
  });

  it('rejects malformed hole names and never treats them as terminal strips', () => {
    expect(validateTactileButtonSeating('pushbutton', [
      { pinName: '1.l', holeName: '10.e' },
      { pinName: '2.l', holeName: '12t.e' },
      { pinName: '1.r', holeName: '10b.j' },
      { pinName: '2.r', holeName: '12b.j' },
    ])).toMatch(/terminal-strip/i);
  });
});

describe('geometry solver — physical button orientation', () => {
  const board = {
    id: 'bb1',
    metadataId: 'breadboard',
    x: 0,
    y: 0,
    properties: {},
  } as const;

  const hole = (name: string) => {
    const found = BREADBOARD_PINS.find((pin) => pin.name === name);
    if (!found) throw new Error(`missing fixture hole ${name}`);
    return found;
  };

  // Real Wokwi pushbutton pin spacing after CSS rotate(90deg), normalised so
  // 1.l is the origin. The sign of dx is mirrored by rotate(270deg), which is
  // electrically equivalent and covered by the validator matrix above.
  const fullRotated: PinOffset[] = [
    { name: '1.l', dx: 0, dy: 0 },
    { name: '2.l', dx: -19, dy: 0 },
    { name: '1.r', dx: 0, dy: 67 },
    { name: '2.r', dx: -19, dy: 67 },
  ];
  const sixMmRotated: PinOffset[] = [
    { name: '1.l', dx: 0, dy: 0 },
    { name: '2.l', dx: -18.8, dy: 0 },
    { name: '1.r', dx: 0, dy: 28 },
    { name: '2.r', dx: -18.8, dy: 28 },
  ];
  const unrotated: PinOffset[] = [
    { name: '1.l', dx: 0, dy: 0 },
    { name: '2.l', dx: 0, dy: 19 },
    { name: '1.r', dx: 67, dy: 0 },
    { name: '2.r', dx: 67, dy: 19 },
  ];

  afterEach(() => {
    document.body.replaceChildren();
  });

  function mountButton(id: string, pinInfo: Array<{ name: string; x: number; y: number }>) {
    // DynamicComponent applies the CSS transform to this wrapper, not to the
    // Wokwi element itself.  Give the test wrapper the same untransformed
    // layout box so calculatePinPosition exercises the real rotation pivot.
    const wrapper = document.createElement('div');
    wrapper.className = 'dynamic-component-wrapper';
    Object.defineProperty(wrapper, 'offsetWidth', { configurable: true, value: 79 });
    Object.defineProperty(wrapper, 'offsetHeight', { configurable: true, value: 74 });
    const element = document.createElement('div') as HTMLDivElement & { pinInfo?: unknown };
    element.id = id;
    element.pinInfo = pinInfo;
    wrapper.appendChild(element);
    document.body.appendChild(wrapper);
  }

  it('uses the rendered 90° pin geometry, not the unrotated footprint', () => {
    const button = [
      { name: '1.l', x: 0, y: 13 },
      { name: '2.l', x: 0, y: 32 },
      { name: '1.r', x: 67, y: 13 },
      { name: '2.r', x: 67, y: 32 },
    ];
    mountButton('button-geometry', button);
    const anchor = hole('20t.e');
    const board = {
      id: 'bb1',
      metadataId: 'breadboard',
      x: 0,
      y: 0,
      properties: {},
    };
    // calculatePinPosition is affine in component x/y for a fixed wrapper;
    // use a zero-origin probe to derive the exact rotated anchor offset, then
    // translate it onto the selected hole.
    const probe = calculatePinPosition('button-geometry', '1.l', 6, 6, 90)!;
    const target = { x: anchor.x + 6, y: anchor.y + 6 };
    const comp = {
      id: 'button-geometry',
      metadataId: 'pushbutton',
      x: target.x - probe.x,
      y: target.y - probe.y,
      properties: { rotation: 90 },
    };
    const seats = computeSeating(comp, [board as never, comp] as never)!;
    expect(seats).toHaveLength(4);
    expect(validateTactileButtonSeating('pushbutton', seats)).toBeNull();
    expect(seats.find((seat) => seat.pinName === '1.l')?.holeName).toBe('20t.e');
    expect(seats.find((seat) => seat.pinName === '1.r')?.holeName).toBe('20b.j');
  });

  it('finds a full-size placement whose generated holes satisfy the trench rule', () => {
    const anchor = hole('20t.e');
    const placed = solvePlacement(
      fullRotated,
      board,
      new Set(),
      anchor.x + 6,
      anchor.y + 6,
    );
    expect(placed).not.toBeNull();
    expect(validateTactileButtonSeating('pushbutton', placed!.holes)).toBeNull();
    expect(new Set(placed!.holes.map((seat) => seat.holeName)).size).toBe(4);
  });

  it('finds a 6mm placement only across the e/f trench', () => {
    const anchor = hole('20t.e');
    const placed = solvePlacement(
      sixMmRotated,
      board,
      new Set(),
      anchor.x + 6,
      anchor.y + 6,
    );
    expect(placed).not.toBeNull();
    expect(validateTactileButtonSeating('pushbutton-6mm', placed!.holes)).toBeNull();
  });

  it('cannot seat the unrotated footprint because each side shorts one strip', () => {
    const anchor = hole('20t.e');
    const placed = solvePlacement(
      unrotated,
      board,
      new Set(),
      anchor.x + 6,
      anchor.y + 6,
    );
    expect(placed).toBeNull();
  });

  it('moves to a free neighbouring footprint when the requested column is occupied', () => {
    const anchor = hole('20t.e');
    const occupied = new Set(['20t.e', '20t.d', '20b.j', '20b.i']);
    const placed = solvePlacement(
      fullRotated,
      board,
      occupied,
      anchor.x + 6,
      anchor.y + 6,
    );
    expect(placed).not.toBeNull();
    expect(placed!.holes.every((seat) => !occupied.has(seat.holeName))).toBe(true);
    expect(validateTactileButtonSeating('pushbutton', placed!.holes)).toBeNull();
  });

  it('seat_component returns one free sibling hole per physical terminal', async () => {
    const previous = useSimulatorStore.getState();
    const button = [
      { name: '1.l', x: 0, y: 13 },
      { name: '2.l', x: 0, y: 32 },
      { name: '1.r', x: 67, y: 13 },
      { name: '2.r', x: 67, y: 32 },
    ];
    mountButton('button-tool', button);
    useSimulatorStore.setState({
      components: [
        { id: 'bb-tool', metadataId: 'breadboard', x: 0, y: 0, properties: {} },
        { id: 'button-tool', metadataId: 'pushbutton', x: 320, y: 180, properties: {} },
      ],
      wires: [],
    } as never);

    const result = await executeTool('seat_component', {
      component_id: 'button-tool',
      breadboard_id: 'bb-tool',
      anchor_pin: '1.l',
      anchor_hole: '20t.e',
    });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.result) as {
      seating: string[];
      external_connection_holes: Record<string, string>;
      terminal_1: { connection_hole: string };
      terminal_2: { connection_hole: string };
    };
    expect(payload.seating).toHaveLength(4);
    const seats = payload.seating.map((edge) => {
      const [pinName, holeName] = edge.split('->');
      return { pinName, holeName };
    });
    expect(validateTactileButtonSeating('pushbutton', seats)).toBeNull();
    expect(payload.terminal_1.connection_hole).toBe(payload.external_connection_holes['1.l']);
    expect(payload.terminal_2.connection_hole).toBe(payload.external_connection_holes['2.l']);

    // External drops must land on free siblings in the same terminal-strip
    // groups, never on the occupied leg holes or the opposite contact.
    const groups = (pinName: string) => {
      const match = /^(\d+)([tb])\./.exec(pinName);
      return match ? `col${match[1]}${match[2]}` : null;
    };
    for (const [pinName, connectionHole] of Object.entries(payload.external_connection_holes)) {
      const seatedHole = seats.find((seat) => seat.pinName === pinName)!.holeName;
      expect(connectionHole).not.toBe(seatedHole);
      expect(groups(connectionHole)).toBe(groups(seatedHole));
    }

    useSimulatorStore.setState({
      boards: previous.boards,
      activeBoardId: previous.activeBoardId,
      components: previous.components,
      wires: previous.wires,
    } as never);
  });

  it('rejects GPIO and GND wires that reuse the exact same button leg', async () => {
    const previous = useSimulatorStore.getState();
    const button = [
      { name: '1.l', x: 0, y: 13 },
      { name: '2.l', x: 0, y: 32 },
      { name: '1.r', x: 67, y: 13 },
      { name: '2.r', x: 67, y: 32 },
    ];
    mountButton('button-short', button);
    const boardElement = document.createElement('div') as HTMLDivElement & { pinInfo?: unknown };
    boardElement.id = 'uno-short';
    boardElement.pinInfo = [
      { name: '2', x: 0, y: 0 },
      { name: 'GND.1', x: 20, y: 0 },
    ];
    document.body.appendChild(boardElement);
    useSimulatorStore.setState({
      boards: [{
        id: 'uno-short',
        boardKind: 'arduino-uno',
        x: 0,
        y: 0,
        activeFileGroupId: 'g-short',
        languageMode: 'arduino',
      }],
      activeBoardId: 'uno-short',
      components: [{ id: 'button-short', metadataId: 'pushbutton', x: 160, y: 80, properties: { rotation: 90 } }],
      wires: [],
    } as never);

    const first = await executeTool('add_wire', {
      start_component: 'button-short',
      start_pin: '1.l',
      end_component: 'uno-short',
      end_pin: '2',
    });
    expect(first.isError).toBe(false);
    const second = await executeTool('add_wire', {
      start_component: 'button-short',
      start_pin: '1.l',
      end_component: 'uno-short',
      end_pin: 'GND.1',
    });
    expect(second.isError).toBe(true);
    expect(second.result).toMatch(/same (?:numbered )?terminal|already has a visible wire/i);

    useSimulatorStore.setState({
      boards: previous.boards,
      activeBoardId: previous.activeBoardId,
      components: previous.components,
      wires: previous.wires,
    } as never);
  });
});
