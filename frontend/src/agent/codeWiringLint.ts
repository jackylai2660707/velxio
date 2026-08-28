/**
 * Read-only code ↔ canvas wiring lint.
 *
 * This is deliberately a conservative, source-level check rather than a C++
 * parser.  It understands the pin expressions normally used in Arduino and
 * ESP32 sketches (`#define LED_PIN 2`, `const int SDA_PIN = 21`, `A0`,
 * `GPIO_NUM_4`) and compares calls such as `analogRead()`/`Servo.attach()`
 * with the live wire graph.  It never mutates either store.
 *
 * A clean result means every pin that could be resolved has a path to a
 * non-board part.  It does not claim that firmware semantics or electrical
 * ratings are correct; `check_circuit` and compile/run remain required.
 */

import { boardPinToNumber } from '../utils/boardPinMapping';
import { breadboardGroupKey, isBreadboard } from '../utils/breadboardNets';
import { validatePinUse } from './boardPinContract';
import type { Wire } from '../types/wire';

export interface CodeWiringBoard {
  id: string;
  boardKind: string;
}

export interface CodeWiringFile {
  name: string;
  content: string;
}

export interface CodeWiringComponent {
  id: string;
  metadataId: string;
}

export type CodeWiringReferenceKind =
  | 'i2c-sda'
  | 'i2c-scl'
  | 'spi-sck'
  | 'spi-miso'
  | 'spi-mosi'
  | 'spi-cs'
  | 'servo'
  | 'analog-input'
  | 'digital-input'
  | 'digital-output'
  | 'dht-data';

export interface CodePinReference {
  kind: CodeWiringReferenceKind;
  api: string;
  expression: string;
  /** Resolved GPIO/AVR/linear pin number, when the board contract provides it. */
  numeric: number | null;
  /** Canonical non-numeric pin label (for example PB7 on STM32). */
  canonical: string | null;
  /** `LED_BUILTIN`/`BUILTIN_LED`; an internal board connection is expected. */
  builtin: boolean;
  /** Whether this came from an explicit argument rather than a board default. */
  explicit: boolean;
  file: string;
  line: number;
}

export type CodeWiringIssueSeverity = 'error' | 'warning' | 'info';

export interface CodeWiringIssue {
  severity: CodeWiringIssueSeverity;
  code: string;
  message: string;
  file?: string;
  line?: number;
  api?: string;
  expression?: string;
  kind?: CodeWiringReferenceKind;
  numeric?: number;
  targets?: string[];
}

export interface CodeWiringLintInput {
  board: CodeWiringBoard;
  files: CodeWiringFile[];
  components: CodeWiringComponent[];
  wires: Pick<Wire, 'start' | 'end' | 'bb'>[];
}

export interface CodeWiringLintResult {
  board: CodeWiringBoard;
  filesScanned: string[];
  references: CodePinReference[];
  issues: CodeWiringIssue[];
  summary: { errors: number; warnings: number; infos: number };
  ok: boolean;
}

interface ResolvedPin {
  raw: string;
  numeric: number | null;
  canonical: string | null;
  builtin: boolean;
  unresolved: boolean;
}

interface Call {
  name: string;
  args: string[];
  index: number;
}

interface SourceContext {
  boardKind: string;
  symbols: Map<string, string>;
}

const BUILTIN_PINS = new Set(['LED_BUILTIN', 'BUILTIN_LED', 'LED_BUILTIN_PIN']);
const PIN_NAME_RE = /^[A-Za-z_]\w*$/;

/** Replace comments, quoted strings, and character literals with spaces while
 * preserving newlines and source offsets.  Regex scans can then not mistake
 * documentation or Serial strings for executable calls. */
function maskSource(source: string): string {
  const chars = source.split('');
  let state: 'code' | 'line-comment' | 'block-comment' | 'string' | 'char' = 'code';
  let escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i++;
        state = 'line-comment';
      } else if (ch === '/' && next === '*') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i++;
        state = 'block-comment';
      } else if (ch === '"') {
        chars[i] = ' ';
        state = 'string';
        escaped = false;
      } else if (ch === "'") {
        chars[i] = ' ';
        state = 'char';
        escaped = false;
      }
    } else if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      else chars[i] = ' ';
    } else if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i++;
        state = 'code';
      } else if (ch !== '\n') {
        chars[i] = ' ';
      }
    } else if (state === 'string' || state === 'char') {
      if (ch === '\n') {
        // Keep malformed multiline literals from swallowing the rest of the
        // file; source line positions remain intact either way.
        state = 'code';
        escaped = false;
      } else {
        chars[i] = ' ';
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if ((state === 'string' && ch === '"') || (state === 'char' && ch === "'")) {
          state = 'code';
        }
      }
    }
  }
  return chars.join('');
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function cleanExpression(expression: string): string {
  return expression
    .trim()
    .replace(/^[({\s]+|[)}\s]+$/g, '')
    .replace(/^static\s+/i, '')
    .replace(/^(?:const|volatile|unsigned|signed)\s+/gi, '')
    .trim();
}

function collectSymbols(masked: string): Map<string, string> {
  const symbols = new Map<string, string>();
  const lines = masked.split('\n');
  for (const line of lines) {
    const define = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+([^\s,;]+)/.exec(line);
    if (define?.[1] && define[2]) symbols.set(define[1], cleanExpression(define[2]));

    // Covers const int, constexpr uint8_t, static byte, gpio_num_t, etc.
    const declaration =
      /\b(?:(?:static|constexpr|const|volatile|extern)\s+)*(?:unsigned\s+|signed\s+|long\s+|short\s+)*(?:u?int(?:8|16|32|64)?(?:_t)?|byte|gpio_num_t|pin_size_t)\s+([A-Za-z_]\w*)\s*=\s*([^;,\n]+)/gi;
    for (const match of line.matchAll(declaration)) {
      if (match[1] && match[2]) symbols.set(match[1], cleanExpression(match[2]));
    }
  }
  return symbols;
}

function parseInteger(token: string): number | null {
  const value = token.replace(/[uUlL]+$/g, '');
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function resolvePin(
  expression: string,
  context: SourceContext,
  depth = 0,
): ResolvedPin {
  const raw = cleanExpression(expression);
  const upper = raw.toUpperCase();
  // A user may intentionally override LED_BUILTIN (`#define LED_BUILTIN 2`)
  // for an external LED.  Resolve an explicit symbol declaration first; only
  // an undeclared core macro is treated as an internal board connection.
  if (BUILTIN_PINS.has(upper) && !context.symbols.has(raw)) {
    return { raw, numeric: null, canonical: upper, builtin: true, unresolved: false };
  }
  if (depth < 8 && PIN_NAME_RE.test(raw) && context.symbols.has(raw)) {
    return resolvePin(context.symbols.get(raw)!, context, depth + 1);
  }

  const integer = parseInteger(raw);
  if (integer !== null) return { raw, numeric: integer, canonical: null, builtin: false, unresolved: false };

  // ESP-IDF names are commonly passed directly to Arduino-compatible helper
  // wrappers (`GPIO_NUM_21`, `GPIO_NUM_4`).
  const gpio = /^GPIO_NUM_(\d+)$/i.exec(raw);
  if (gpio?.[1]) {
    return { raw, numeric: Number.parseInt(gpio[1], 10), canonical: null, builtin: false, unresolved: false };
  }

  const mapped = boardPinToNumber(context.boardKind, raw);
  if (mapped !== null) {
    if (mapped < 0) return { raw, numeric: null, canonical: upper, builtin: false, unresolved: false };
    // Keep STM32 port labels so diagnostics remain meaningful while numeric
    // matching still works against boardPinToNumber().
    const canonical = /^P[A-G]\d{1,2}$/i.test(raw) ? upper : null;
    return { raw, numeric: mapped, canonical, builtin: false, unresolved: false };
  }

  return { raw, numeric: null, canonical: upper || null, builtin: false, unresolved: true };
}

function splitArguments(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      result.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail || result.length > 0) result.push(tail);
  return result;
}

/** Extract calls for a method/function regex. Regex must include the opening
 * parenthesis in its match and use a capture group as the call name when
 * needed. */
function extractCalls(masked: string, pattern: RegExp, name: (match: RegExpExecArray) => string): Call[] {
  const calls: Call[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked))) {
    const open = masked.indexOf('(', match.index);
    if (open < 0) continue;
    let depth = 1;
    let close = open + 1;
    for (; close < masked.length && depth > 0; close++) {
      if (masked[close] === '(') depth++;
      else if (masked[close] === ')') depth--;
    }
    if (depth !== 0) continue;
    calls.push({ name: name(match), args: splitArguments(masked.slice(open + 1, close - 1)), index: match.index });
  }
  return calls;
}

function defaultsFor(boardKind: string): {
  i2c?: [string, string];
  spi?: [string, string, string, string];
} {
  const kind = boardKind.toLowerCase();
  if (kind === 'arduino-uno' || kind === 'arduino-nano') {
    return { i2c: ['A4', 'A5'], spi: ['13', '12', '11', '10'] };
  }
  if (kind === 'arduino-mega') {
    return { i2c: ['20', '21'], spi: ['52', '50', '51', '53'] };
  }
  if (kind === 'raspberry-pi-pico' || kind === 'pi-pico-w' || kind === 'nano-rp2040') {
    return { i2c: ['GP4', 'GP5'], spi: ['GP18', 'GP16', 'GP19', 'GP17'] };
  }
  if (kind.includes('esp32-c3')) return { i2c: ['8', '9'] };
  if (kind.includes('esp32-s3') || kind.includes('nano-esp32') || kind.includes('xiao-esp32-s3')) {
    return { i2c: ['8', '9'] };
  }
  if (kind === 'esp32' || kind.includes('esp32') || kind.includes('lolin32')) {
    return { i2c: ['21', '22'], spi: ['18', '19', '23', '5'] };
  }
  // The STM32 examples and Arduino core use PB7=SDA/PB6=SCL for I2C1.
  if (kind.startsWith('stm32-')) return { i2c: ['PB7', 'PB6'] };
  return {};
}

function i2cDefaultsForCall(
  boardKind: string,
  busName: string,
  defaults: ReturnType<typeof defaultsFor>,
): [string, string] | undefined {
  const kind = boardKind.toLowerCase();
  // RP2040 Wire1 is I2C1 on GP6 (SDA) / GP7 (SCL); Wire is I2C0 on GP4/GP5.
  if ((kind === 'raspberry-pi-pico' || kind === 'pi-pico-w' || kind === 'nano-rp2040') && /^wire1$/i.test(busName)) {
    return ['GP6', 'GP7'];
  }
  // Other `WireN` instances are carrier/core-specific (ESP32 Wire1 defaults
  // differ across Arduino-core versions and custom boards).  Do not invent a
  // pair of GPIOs; explicit `Wire1.begin(sda, scl)` calls remain fully linted.
  if (!/^wire$/i.test(busName)) return undefined;
  return defaults.i2c;
}

function targetNode(componentId: string, pinName: string): string {
  return `${componentId}\u0000${pinName}`;
}

function isBreadboardComponent(component: CodeWiringComponent | undefined): boolean {
  return Boolean(component?.metadataId.toLowerCase().includes('breadboard'));
}

interface ConnectedTarget {
  componentId: string;
  pinName: string;
  metadataId?: string;
}

function connectedTargets(
  board: CodeWiringBoard,
  pin: ResolvedPin,
  wires: Pick<Wire, 'start' | 'end' | 'bb'>[],
  components: CodeWiringComponent[],
): ConnectedTarget[] {
  const componentMap = new Map(components.map((component) => [component.id, component]));
  const edges = new Map<string, string[]>();
  const addEdge = (a: string, b: string) => {
    edges.set(a, [...(edges.get(a) ?? []), b]);
  };
  for (const wire of wires) {
    const a = targetNode(wire.start.componentId, wire.start.pinName);
    const b = targetNode(wire.end.componentId, wire.end.pinName);
    addEdge(a, b);
    addEdge(b, a);
  }

  // Breadboard holes in the same terminal strip/rail are internally joined;
  // no explicit wire exists between them.  Add a star edge per group so a
  // board pin wired to one hole can reach a seated leg in a neighbouring hole.
  const groupRoots = new Map<string, string>();
  for (const wire of wires) {
    for (const endpoint of [wire.start, wire.end]) {
      const component = componentMap.get(endpoint.componentId);
      if (!component || !isBreadboard(component.metadataId)) continue;
      const group = breadboardGroupKey(component.metadataId, endpoint.pinName);
      if (!group) continue;
      const node = targetNode(endpoint.componentId, endpoint.pinName);
      const groupId = `${endpoint.componentId}\u0000${group}`;
      const root = groupRoots.get(groupId);
      if (!root) {
        groupRoots.set(groupId, node);
      } else if (root !== node) {
        addEdge(root, node);
        addEdge(node, root);
      }
    }
  }

  const starts: string[] = [];
  for (const wire of wires) {
    for (const endpoint of [wire.start, wire.end]) {
      if (endpoint.componentId !== board.id) continue;
      const mapped = boardPinToNumber(board.boardKind, endpoint.pinName);
      const sameNumeric = pin.numeric !== null && mapped !== null && mapped >= 0 && mapped === pin.numeric;
      const sameCanonical = pin.canonical !== null && endpoint.pinName.toUpperCase() === pin.canonical;
      if (sameNumeric || sameCanonical) starts.push(targetNode(endpoint.componentId, endpoint.pinName));
    }
  }
  if (starts.length === 0) return [];

  const queue = [...new Set(starts)];
  const visited = new Set(queue);
  const targets: ConnectedTarget[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const split = node.indexOf('\u0000');
    const componentId = split >= 0 ? node.slice(0, split) : node;
    const pinName = split >= 0 ? node.slice(split + 1) : '';
    if (componentId !== board.id) {
      const component = componentMap.get(componentId);
      if (!isBreadboardComponent(component)) {
        targets.push({ componentId, pinName, metadataId: component?.metadataId });
      }
    }
    for (const next of edges.get(node) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  const unique = new Map<string, ConnectedTarget>();
  for (const target of targets) unique.set(`${target.componentId}\u0000${target.pinName}`, target);
  return [...unique.values()];
}

function protocolRole(pinName: string): CodeWiringReferenceKind | null {
  const name = pinName.toUpperCase();
  // Keep I²C names exact.  `SCK`/`CLK` are SPI names on most displays;
  // treating them as SCL caused a valid SPI bus to be reported as an I²C
  // mismatch.  Generic DATA/CLK labels remain deliberately unknown because
  // they are used by both I²C breakouts and SPI displays.
  if (/^SDA$/.test(name) || /(^|[._-])SDA($|[._-])/.test(name)) return 'i2c-sda';
  if (/^SCL$/.test(name) || /(^|[._-])SCL($|[._-])/.test(name)) return 'i2c-scl';
  if (/^(MOSI|SDO|DIN)$/.test(name)) return 'spi-mosi';
  if (/^(MISO|SDI|DOUT)$/.test(name)) return 'spi-miso';
  if (/^(SCK|SCLK|CLK|CLOCK)$/.test(name)) return 'spi-sck';
  if (/^(CS|SS|NSS|CHIP.?SELECT)$/.test(name)) return 'spi-cs';
  return null;
}

function expressionLooksLikeCs(expression: string): boolean {
  const name = cleanExpression(expression).toUpperCase();
  return /(^|[_-])(CS|SS|NSS|CHIP.?SELECT|SELECT)([_-]|$)/.test(name) || /^(CS|SS|NSS)$/.test(name);
}

function addReference(
  references: CodePinReference[],
  context: SourceContext,
  file: string,
  source: string,
  kind: CodeWiringReferenceKind,
  api: string,
  expression: string,
  index: number,
  explicit: boolean,
): void {
  const resolved = resolvePin(expression, context);
  references.push({
    kind,
    api,
    expression: cleanExpression(expression),
    numeric: resolved.numeric,
    canonical: resolved.canonical,
    builtin: resolved.builtin,
    explicit,
    file,
    line: lineAt(source, index),
  });
}

function dedupeReferences(references: CodePinReference[]): CodePinReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const pin = reference.numeric !== null ? `n${reference.numeric}` : `c${reference.canonical ?? reference.expression}`;
    const key = `${reference.file}:${reference.line}:${reference.kind}:${pin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferReferences(
  file: CodeWiringFile,
  boardKind: string,
  sharedSymbols?: ReadonlyMap<string, string>,
): CodePinReference[] {
  const masked = maskSource(file.content);
  const symbols = new Map(sharedSymbols);
  for (const [name, value] of collectSymbols(masked)) symbols.set(name, value);
  const context: SourceContext = { boardKind, symbols };
  const references: CodePinReference[] = [];
  const defaults = defaultsFor(boardKind);

  const wireBegins = extractCalls(masked, /\b(Wire\w*)\s*\.\s*begin\s*\(/g, (m) => m[1] ?? 'Wire.begin');
  for (const call of wireBegins) {
    if (call.args.length >= 2 && call.args[0] && call.args[1]) {
      addReference(references, context, file.name, file.content, 'i2c-sda', `${call.name}.begin`, call.args[0], call.index, true);
      addReference(references, context, file.name, file.content, 'i2c-scl', `${call.name}.begin`, call.args[1], call.index, true);
    } else if (call.args.length === 0) {
      const i2cDefaults = i2cDefaultsForCall(boardKind, call.name, defaults);
      if (!i2cDefaults) continue;
      addReference(references, context, file.name, file.content, 'i2c-sda', `${call.name}.begin`, i2cDefaults[0], call.index, false);
      addReference(references, context, file.name, file.content, 'i2c-scl', `${call.name}.begin`, i2cDefaults[1], call.index, false);
    }
  }

  const spiBegins = extractCalls(masked, /\bSPI\w*\s*\.\s*begin\s*\(/g, (m) => m[0]?.split(/[.(]/)[0] ?? 'SPI');
  for (const call of spiBegins) {
    if (call.args.length >= 3) {
      const roles: CodeWiringReferenceKind[] = ['spi-sck', 'spi-miso', 'spi-mosi'];
      roles.forEach((kind, index) => {
        const expression = call.args[index];
        if (expression) addReference(references, context, file.name, file.content, kind, 'SPI.begin', expression, call.index, true);
      });
      if (call.args[3]) addReference(references, context, file.name, file.content, 'spi-cs', 'SPI.begin', call.args[3], call.index, true);
    } else if (call.args.length === 0 && defaults.spi) {
      const roles: CodeWiringReferenceKind[] = ['spi-sck', 'spi-miso', 'spi-mosi', 'spi-cs'];
      roles.forEach((kind, index) => {
        const expression = defaults.spi?.[index];
        if (expression) addReference(references, context, file.name, file.content, kind, 'SPI.begin', expression, call.index, false);
      });
    }
  }

  const pinCalls = extractCalls(masked, /\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite)\s*\(/g, (m) => m[1] ?? 'pin');
  for (const call of pinCalls) {
    const expression = call.args[0];
    if (!expression) continue;
    const symbolCs = expressionLooksLikeCs(expression);
    let kind: CodeWiringReferenceKind;
    if (call.name === 'analogRead') kind = 'analog-input';
    else if (call.name === 'analogWrite') kind = symbolCs ? 'spi-cs' : 'digital-output';
    else if (call.name === 'digitalRead') kind = 'digital-input';
    else if (call.name === 'digitalWrite') kind = symbolCs ? 'spi-cs' : 'digital-output';
    else {
      const mode = (call.args[1] ?? '').toUpperCase();
      kind = symbolCs ? 'spi-cs' : mode.includes('INPUT') ? 'digital-input' : 'digital-output';
    }
    addReference(references, context, file.name, file.content, kind, call.name, expression, call.index, true);
  }

  // Restrict `.attach()` to objects declared as Servo where possible.  Many
  // unrelated libraries expose an attach() method; treating every such call
  // as a servo pin creates noisy false positives in otherwise valid sketches.
  const servoObjects = new Set<string>();
  for (const match of masked.matchAll(/\b(?:Servo|ServoTimer2|ESP32Servo)\s+([A-Za-z_]\w*)/g)) {
    if (match[1]) servoObjects.add(match[1]);
  }
  const servoCalls = extractCalls(
    masked,
    servoObjects.size > 0
      ? new RegExp(`\\b(${[...servoObjects].map((name) => name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|')})\\s*\\.\\s*attach\\s*\\(`, 'g')
      : /\b[A-Za-z_]\w*\s*\.\s*attach\s*\(/g,
    () => 'Servo.attach',
  );
  for (const call of servoCalls) {
    if (call.args[0]) addReference(references, context, file.name, file.content, 'servo', 'Servo.attach', call.args[0], call.index, true);
  }

  const dhtConstructors = extractCalls(
    masked,
    /\b(?:DHT(?:_Unified)?|DHTesp)\s+[A-Za-z_]\w*\s*\(/g,
    (m) => m[0]?.trim().split(/\s+/)[0] ?? 'DHT',
  );
  for (const call of dhtConstructors) {
    if (call.args[0]) addReference(references, context, file.name, file.content, 'dht-data', call.name, call.args[0], call.index, true);
  }
  const dhtSetup = extractCalls(masked, /\b[A-Za-z_]\w*\s*\.\s*setup\s*\(/g, () => 'DHT.setup');
  for (const call of dhtSetup) {
    if (call.args[0] && call.args[1]?.toUpperCase().includes('DHT')) {
      addReference(references, context, file.name, file.content, 'dht-data', 'DHT.setup', call.args[0], call.index, true);
    }
  }

  // MicroPython I2C form: I2C(0, sda=Pin(21), scl=Pin(22)).  It is cheap to
  // understand and prevents a Python ESP32 project from bypassing this lint.
  const i2cCalls = extractCalls(masked, /\bI2C\s*\(/g, () => 'I2C');
  for (const call of i2cCalls) {
    const joined = call.args.join(',');
    const sda = /\bsda\s*=\s*Pin\s*\(\s*([^,)]+)/i.exec(joined)?.[1];
    const scl = /\bscl\s*=\s*Pin\s*\(\s*([^,)]+)/i.exec(joined)?.[1];
    if (sda) addReference(references, context, file.name, file.content, 'i2c-sda', 'I2C', sda, call.index, true);
    if (scl) addReference(references, context, file.name, file.content, 'i2c-scl', 'I2C', scl, call.index, true);
  }

  return dedupeReferences(references);
}

function pinDescription(reference: CodePinReference): string {
  if (reference.numeric !== null) return `pin ${reference.expression} (GPIO/pin ${reference.numeric})`;
  return `pin ${reference.expression}`;
}

function lintFileReferences(
  references: CodePinReference[],
  board: CodeWiringBoard,
  wires: Pick<Wire, 'start' | 'end' | 'bb'>[],
  components: CodeWiringComponent[],
): CodeWiringIssue[] {
  const issues: CodeWiringIssue[] = [];
  const checked = new Set<string>();
  for (const reference of references) {
    if (reference.builtin) {
      issues.push({
        severity: 'info',
        code: 'BUILTIN_PIN',
        message: `${reference.api} uses ${reference.expression}; treated as the board's internal built-in connection.`,
        file: reference.file,
        line: reference.line,
        api: reference.api,
        expression: reference.expression,
        kind: reference.kind,
      });
      continue;
    }
    if (reference.numeric === null && reference.canonical !== null) {
      // Power aliases are intentionally not expected in GPIO APIs, but an
      // unresolved symbol should be made visible rather than silently treated
      // as a valid wire.
      if (reference.canonical === reference.expression.toUpperCase() && !/^P[A-G]\d{1,2}$/.test(reference.canonical)) {
        // Indexed arrays and arithmetic expressions are common for LED
        // matrices (`ledPins[i]`) but cannot be mapped to one physical pin
        // without executing the loop.  Keep the finding visible while
        // avoiding a false hard failure; the deterministic hardware checks
        // still guard any concrete wires the student drew.
        if (!PIN_NAME_RE.test(reference.expression)) {
          issues.push({
            severity: 'warning',
            code: 'DYNAMIC_PIN_EXPRESSION',
            message: `${reference.api} uses dynamic pin expression ${reference.expression}; static lint cannot map it to one canvas pin. Check every array element/branch against the wiring manually.`,
            file: reference.file,
            line: reference.line,
            api: reference.api,
            expression: reference.expression,
            kind: reference.kind,
          });
          continue;
        }
        issues.push({
          severity: 'error',
          code: 'UNRESOLVED_PIN',
          message: `${reference.api} uses ${reference.expression}, but this pin expression cannot be resolved for ${board.boardKind}. Define it as a GPIO/pin number or board label before wiring.`,
          file: reference.file,
          line: reference.line,
          api: reference.api,
          expression: reference.expression,
          kind: reference.kind,
        });
        continue;
      }
    }
    if (reference.numeric === null && reference.canonical === null) continue;
    const pinKey = reference.numeric !== null ? `n${reference.numeric}` : `c${reference.canonical}`;
    const connectionKey = `${reference.kind}:${pinKey}`;
    if (checked.has(connectionKey)) continue;
    checked.add(connectionKey);

    const resolved: ResolvedPin = {
      raw: reference.expression,
      numeric: reference.numeric,
      canonical: reference.canonical,
      builtin: false,
      unresolved: false,
    };
    const targets = connectedTargets(board, resolved, wires, components);
    const targetLabels = targets.map((target) => `${target.componentId}:${target.pinName}`);
    if (targets.length === 0) {
      const severity: CodeWiringIssueSeverity = reference.explicit ? 'error' : 'warning';
      issues.push({
        severity,
        code: 'PIN_NOT_WIRED',
        message: `${reference.api} expects ${pinDescription(reference)}, but no wire reaches a component. Add or repair the board-to-part connection.`,
        file: reference.file,
        line: reference.line,
        api: reference.api,
        expression: reference.expression,
        kind: reference.kind,
        numeric: reference.numeric ?? undefined,
      });
      continue;
    }

    const expectedProtocol = reference.kind.startsWith('i2c-') || reference.kind.startsWith('spi-') ? reference.kind : null;
    if (expectedProtocol) {
      const knownRoles = targets
        .map((target) => protocolRole(target.pinName))
        .filter((role): role is CodeWiringReferenceKind => role !== null);
      // If every recognisable target is the opposite bus role, report a likely
      // SDA/SCL (or MOSI/MISO/CS) swap. Unknown generic pins are accepted: a
      // custom chip may quite legitimately name its bus pins IN/OUT.
      if (knownRoles.length > 0 && knownRoles.every((role) => role !== expectedProtocol)) {
        issues.push({
          severity: 'error',
          code: 'PROTOCOL_PIN_MISMATCH',
          message: `${reference.api} uses ${pinDescription(reference)} for ${expectedProtocol}, but it reaches ${targetLabels.join(', ')}. Check for swapped or wrong ${expectedProtocol.replace('-', ' ')} wiring.`,
          file: reference.file,
          line: reference.line,
          api: reference.api,
          expression: reference.expression,
          kind: reference.kind,
          numeric: reference.numeric ?? undefined,
          targets: targetLabels,
        });
      }
    }
  }
  return issues;
}

function addCodePinRoleConflicts(
  references: CodePinReference[],
  issues: CodeWiringIssue[],
): void {
  const groups = new Map<string, CodePinReference[]>();
  for (const reference of references) {
    if (reference.builtin || reference.numeric === null) continue;
    const key = `n${reference.numeric}`;
    groups.set(key, [...(groups.get(key) ?? []), reference]);
  }
  const isInput = (kind: CodeWiringReferenceKind) =>
    kind === 'analog-input' || kind === 'digital-input' || kind === 'spi-miso';
  const isOutput = (kind: CodeWiringReferenceKind) =>
    kind === 'digital-output' || kind === 'servo' || kind === 'spi-mosi' || kind === 'spi-sck' || kind === 'spi-cs';
  for (const refs of groups.values()) {
    const inputs = refs.filter((reference) => isInput(reference.kind));
    const outputs = refs.filter((reference) => isOutput(reference.kind));
    if (inputs.length === 0 || outputs.length === 0) continue;
    const first = refs[0];
    if (!first) continue;
    const names = [...new Set(refs.map((reference) => reference.api))].join(', ');
    issues.push({
      severity: 'error',
      code: 'CODE_PIN_ROLE_CONFLICT',
      message: `GPIO/pin ${first.numeric} is used as both input and output (${names}). Split the signals onto separate pins; shared push-pull drive can damage real hardware.`,
      file: first.file,
      line: first.line,
      numeric: first.numeric ?? undefined,
      expression: first.expression,
    });
  }
}

function addBoardContractIssues(
  references: CodePinReference[],
  board: CodeWiringBoard,
  issues: CodeWiringIssue[],
): void {
  const seen = new Set<string>();
  for (const reference of references) {
    if (reference.builtin || reference.numeric === null) continue;
    const use =
      reference.kind === 'digital-input' || reference.kind === 'analog-input' || reference.kind === 'spi-miso'
        ? 'input'
        : reference.kind === 'digital-output' || reference.kind === 'servo' || reference.kind === 'spi-mosi' || reference.kind === 'spi-sck' || reference.kind === 'spi-cs'
          ? 'output'
          : 'wire';
    // `resolvePin` already canonicalized aliases to a number.  Resolving that
    // number against the board contract handles GPIO_NUM_x and D/A aliases
    // uniformly; use the source expression first to preserve labels such as
    // PB7 on STM32.
    const validation = validatePinUse(board.boardKind, reference.expression, use);
    const fallback = validation.pin ? validation : validatePinUse(board.boardKind, String(reference.numeric), use);
    if (!fallback.pin) continue; // unknown/overlay board: stay conservative
    const keyBase = `${reference.numeric}:${reference.kind}`;
    for (const message of fallback.errors) {
      const key = `error:${keyBase}:${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        severity: 'error',
        code: 'BOARD_PIN_UNSAFE',
        message: `${reference.api} uses ${reference.expression} on ${board.boardKind}: ${message}`,
        file: reference.file,
        line: reference.line,
        api: reference.api,
        expression: reference.expression,
        kind: reference.kind,
        numeric: reference.numeric,
      });
    }
    for (const message of fallback.warnings) {
      const key = `warning:${keyBase}:${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        severity: 'warning',
        code: 'BOARD_PIN_CAUTION',
        message: `${reference.api} uses ${reference.expression} on ${board.boardKind}: ${message}`,
        file: reference.file,
        line: reference.line,
        api: reference.api,
        expression: reference.expression,
        kind: reference.kind,
        numeric: reference.numeric,
      });
    }
  }
}

/** Run source-to-canvas lint without changing either Zustand store. */
export function lintCodeWiring(input: CodeWiringLintInput): CodeWiringLintResult {
  // Headers often carry the pin contract (`pins.h` → `sketch.ino`).  Merge
  // declarations across the board's file group, then let declarations in the
  // file containing the call override a shared value.  This remains static
  // and read-only; no preprocessor execution is attempted.
  const sharedSymbols = new Map<string, string>();
  for (const file of input.files) {
    for (const [name, value] of collectSymbols(maskSource(file.content))) {
      sharedSymbols.set(name, value);
    }
  }
  const references = input.files.flatMap((file) => inferReferences(file, input.board.boardKind, sharedSymbols));
  const issues = lintFileReferences(references, input.board, input.wires, input.components);
  addBoardContractIssues(references, input.board, issues);
  addCodePinRoleConflicts(references, issues);
  const summary = {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    infos: issues.filter((issue) => issue.severity === 'info').length,
  };
  return {
    board: input.board,
    filesScanned: input.files.map((file) => file.name),
    references,
    issues,
    summary,
    ok: summary.errors === 0,
  };
}

/** Compact text form suitable for an agent tool result and chat transcript. */
export function formatCodeWiringLint(result: CodeWiringLintResult): string {
  const lines = [
    `CODE↔WIRING LINT board="${result.board.id}" (${result.board.boardKind}) — ${result.filesScanned.length} file(s), ${result.references.length} pin reference(s)`,
  ];
  if (result.issues.length === 0) {
    lines.push('PASS: every resolved code pin has a path to a canvas component.');
  } else {
    for (const issue of result.issues) {
      const location = issue.file ? ` ${issue.file}:${issue.line ?? 1}` : '';
      lines.push(`${issue.severity.toUpperCase()} [${issue.code}]${location}: ${issue.message}`);
    }
  }
  lines.push(`SUMMARY: ${result.summary.errors} error(s), ${result.summary.warnings} warning(s), ${result.summary.infos} info; ${result.ok ? 'code and wiring are aligned' : 'repair errors before compile/run'}.`);
  return lines.join('\n');
}
