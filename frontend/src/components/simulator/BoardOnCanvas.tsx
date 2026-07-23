import React from 'react';
import type { BoardInstance } from '../../types/board';
import { ArduinoUno } from '../velxio-components/ArduinoUno';
import { ArduinoNano } from '../velxio-components/ArduinoNano';
import { ArduinoMega } from '../velxio-components/ArduinoMega';
// NanoRP2040 (wokwi-nano-rp2040-connect) used to back the 'raspberry-pi-pico'
// boardKind by mistake — kept the import out so future contributors don't
// re-wire it back in. If someone genuinely needs a Nano RP2040 Connect
// board (D2..D13 labels), add a new boardKind 'arduino-nano-rp2040'.
import { RaspberryPi3 } from '../velxio-components/RaspberryPi3';
import { RaspberryPi4 } from '../velxio-components/RaspberryPi4';
import { RaspberryPi5 } from '../velxio-components/RaspberryPi5';
import { Esp32 } from '../velxio-components/Esp32';
import { Attiny85 } from '../velxio-components/Attiny85';
import { PiPicoW } from '../velxio-components/PiPicoW';
import {
  Stm32BluePill,
  Stm32BlackPill,
  Stm32BluePillF103CB,
  Stm32BlackPillF401,
  Stm32F4Discovery,
  Stm32OlimexH405,
  Stm32NetduinoPlus2,
  Stm32Netduino2,
} from '../velxio-components/Stm32BluePill';
import { PinOverlay } from './PinOverlay';

import { BOARD_SIZE } from '../../types/boardSizes';
// Re-exported for existing importers (CanvasMinimap).
export { BOARD_SIZE };

interface BoardOnCanvasProps {
  board: BoardInstance;
  running: boolean;
  led13?: boolean;
  isActive?: boolean;
  /** When false, the pin overlay is hidden — keeps the canvas uncluttered when
   * the user isn't hovering, isn't selecting, and isn't actively wiring. */
  showPins?: boolean;
  /** True while a wire is in progress — forwarded to PinOverlay so dense
   * boards paint every square (they're all valid wire targets). */
  wiring?: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onPinClick: (componentId: string, pinName: string, x: number, y: number) => void;
  zoom?: number;
}

export const BoardOnCanvas = ({
  board,
  running,
  led13 = false,
  isActive = false,
  showPins = true,
  wiring = false,
  onMouseDown,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  onPinClick,
  zoom = 1,
}: BoardOnCanvasProps) => {
  const { id, boardKind, x, y } = board;
  const size = BOARD_SIZE[boardKind] ?? { w: 300, h: 200 };

  // Status dot color: green=running, amber=compiled, gray=idle
  const statusColor = board.running ? '#22c55e' : board.compiledProgram ? '#f59e0b' : '#6b7280';

  const boardEl = (() => {
    switch (boardKind) {
      case 'arduino-uno':
        return <ArduinoUno id={id} x={x} y={y} led13={led13} />;
      case 'arduino-nano':
        return <ArduinoNano id={id} x={x} y={y} led13={led13} />;
      case 'arduino-mega':
        return <ArduinoMega id={id} x={x} y={y} led13={led13} />;
      // 'raspberry-pi-pico' used to render <NanoRP2040> (a wokwi-nano-
      // rp2040-connect element with D2-D13 pin labels). That was a
      // misnaming bug — the Nano RP2040 Connect is a different board.
      // Use the same Pico Web Component as 'pi-pico-w' so the pins are
      // labeled GP0..GP28, 3V3, VBUS, etc. — matching the FQBN
      // (rp2040:rp2040:rpipico) and every Pi-Pico sketch's #defines.
      case 'raspberry-pi-pico':
      case 'pi-pico-w':
        return <PiPicoW id={id} x={x} y={y} />;
      case 'raspberry-pi-3':
        return <RaspberryPi3 id={id} x={x} y={y} />;
      case 'raspberry-pi-4':
        return <RaspberryPi4 id={id} x={x} y={y} />;
      case 'raspberry-pi-5':
        return <RaspberryPi5 id={id} x={x} y={y} />;
      case 'esp32':
      case 'esp32-devkit-c-v4':
      case 'esp32-cam':
      case 'wemos-lolin32-lite':
      case 'esp32-s3':
      case 'xiao-esp32-s3':
      case 'arduino-nano-esp32':
      case 'esp32-c3':
      case 'xiao-esp32-c3':
      case 'aitewinrobot-esp32c3-supermini':
        return <Esp32 id={id} x={x} y={y} boardKind={boardKind} />;
      case 'stm32-bluepill':
        return <Stm32BluePill id={id} x={x} y={y} />;
      case 'stm32-blackpill':
        return <Stm32BlackPill id={id} x={x} y={y} />;
      case 'stm32-bluepill-f103cb':
        return <Stm32BluePillF103CB id={id} x={x} y={y} />;
      case 'stm32-blackpill-f401':
        return <Stm32BlackPillF401 id={id} x={x} y={y} />;
      case 'stm32-f4-discovery':
        return <Stm32F4Discovery id={id} x={x} y={y} />;
      case 'stm32-olimex-h405':
        return <Stm32OlimexH405 id={id} x={x} y={y} />;
      case 'stm32-netduino-plus2':
        return <Stm32NetduinoPlus2 id={id} x={x} y={y} />;
      case 'stm32-netduino2':
        return <Stm32Netduino2 id={id} x={x} y={y} />;
      case 'attiny85':
        return <Attiny85 id={id} x={x} y={y} led1={led13} />;
    }
  })();

  return (
    // Zero-size positioned wrapper: children keep their absolute canvas
    // coords, but board + pins now share ONE stacking context, so this
    // board's pins can never paint above a component/board covering it.
    // z 0 keeps every board below components (their groups use z 1/2).
    // Hover handlers live HERE, on the wrapper that owns both the drag
    // overlay AND the pin squares — putting them on the drag overlay (a
    // sibling of PinOverlay) made moving onto a pin fire mouseleave, which
    // cleared the hover and hid the pins before you could click one.
    <div
      style={{ position: 'absolute', left: 0, top: 0, zIndex: 0 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {boardEl}

      {/* Active board highlight ring */}
      {isActive && (
        <div
          style={{
            position: 'absolute',
            left: x - 3,
            top: y - 3,
            width: size.w + 6,
            height: size.h + 6,
            border: '2px solid #007acc',
            borderRadius: 6,
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      )}

      {/* Status dot — top-right corner */}
      <div
        style={{
          position: 'absolute',
          left: x + size.w - 10,
          top: y - 6,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: statusColor,
          border: '2px solid #1e1e1e',
          pointerEvents: 'none',
          zIndex: 10,
          transition: 'background 0.3s',
        }}
        title={board.running ? 'Running' : board.compiledProgram ? 'Compiled' : 'Idle'}
      />

      {/* Drag overlay — hidden during simulation */}
      {!running && (
        <div
          data-board-overlay="true"
          data-board-id={id}
          style={{
            position: 'absolute',
            left: x,
            top: y,
            width: size.w,
            height: size.h,
            cursor: 'move',
            zIndex: 1,
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onMouseDown(e);
          }}
          onContextMenu={onContextMenu}
        />
      )}

      {/* Pin overlay for wire connections */}
      <PinOverlay
        componentId={id}
        componentX={x}
        componentY={y}
        onPinClick={onPinClick}
        showPins={showPins}
        wrapperOffsetX={0}
        wrapperOffsetY={0}
        zoom={zoom}
        wiring={wiring}
      />
    </div>
  );
};
