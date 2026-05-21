# Phase 2.CR — USB Serial/JTAG Controller peripheral (TRM Chapter 51)

**Estado**: ✅ done — replaces the existing
`create_unimplemented_device("esp32p4.usb_serial_jtag")` smart_stub
at `0x500D2000` with a real peripheral skeleton that decodes the
EP1 + WR_DONE TX flow. **Closes the Phase 2.CC documentation-only
gap for `DIS_USB_SERIAL_JTAG`** — that eFuse bit now actually
disables the peripheral. **34th JSON event type** (`usb_jtag_tx`).

Live verification (2026-05-21):

```
default boot — 8 usb_jtag_tx events spelling "VelxioP4":
  TX #1 0x56 ('V')     {"event":"usb_jtag_tx","seq":1,"byte":86}
  TX #2 0x65 ('e')     {"event":"usb_jtag_tx","seq":2,"byte":101}
  TX #3 0x6C ('l')     {"event":"usb_jtag_tx","seq":3,"byte":108}
  TX #4 0x78 ('x')     {"event":"usb_jtag_tx","seq":4,"byte":120}
  TX #5 0x69 ('i')     {"event":"usb_jtag_tx","seq":5,"byte":105}
  TX #6 0x6F ('o')     {"event":"usb_jtag_tx","seq":6,"byte":111}
  TX #7 0x50 ('P')     {"event":"usb_jtag_tx","seq":7,"byte":80}
  TX #8 0x34 ('4')     {"event":"usb_jtag_tx","seq":8,"byte":52}

with VELXIO_EFUSE_DIS_USB_SERIAL_JTAG=1:
  [esp32p4.usb_serial_jtag] self-test skipped — eFuse DIS_USB_SERIAL_JTAG=1
  0 usb_jtag_tx events ✓
```

The eFuse → peripheral clock-gate chain is now silicon-faithful
for USB-Serial/JTAG too (matches Phase 2.CC's DIS_TWAI pattern).

## Goal

Phase 2.CC introduced `DIS_USB_SERIAL_JTAG` (and `DIS_USB_JTAG`)
as eFuse bits but documented them as "exposed but not wired (USB
peripherals not yet modeled)". This phase models the peripheral
and wires the bit, replacing the smart_stub.

Real silicon behavior:
- USB Serial/JTAG is the **default Arduino Serial output** on
  modern ESP32-P4 boards via the native USB-OTG pins.
- `Serial.print()` ultimately routes through this peripheral
  when configured for USB CDC mode (vs UART mode).
- Many Arduino IDE defaults pick USB-CDC for ESP32 boards with
  native USB — the user types "Serial.print(...)" expecting it
  to show in the Serial Monitor, no UART cable required.

The skeleton emits a `usb_jtag_tx` JSON event per TX byte so the
frontend can render a USB-Serial monitor view in parallel with
the UART-side TX monitor (Phase 2.AW). DIS_USB_SERIAL_JTAG gate
ensures programmatically-disabled peripherals stay silent.

## Lo que SE INVESTIGÓ

### 1. TRM Chapter 51 + IDF register layout

Per `_TRM_TOC.txt`:
```
- 51 USB Serial/JTAG Controller (USB_SERIAL_JTAG)
    - 51.1 Overview
    - 51.2 Features
    - 51.3 Functional Description
    - 51.4 Recommended Operation
    - 51.5 Interrupts
    - 51.6 Register Summary
    - 51.7 Registers
```

Per IDF `reg_base.h`:
```c
#define DR_REG_USB2JTAG_BASE      (DR_REG_HPPERIPH1_BASE + 0x12000)
#define DR_REG_USB_SERIAL_JTAG_BASE  DR_REG_USB2JTAG_BASE
```
With `HPPERIPH1_BASE = 0x500C0000`, this gives `0x500D2000` — which
is exactly where the existing
`create_unimplemented_device("esp32p4.usb_serial_jtag", 0x500D2000, 0x1000)`
smart_stub lives. Overlay priority 2 takes precedence over the
smart_stub's priority 1.

Per IDF `usb_serial_jtag_reg.h`:
```
0x00  EP1                R/W byte exchange with host
0x04  EP1_CONF           bit 0 WR_DONE, bit 1 SERIAL_IN_EMPTY,
                         bit 2 SERIAL_OUT_EP_DATA_AVAIL
0x08  INT_RAW
0x0C  INT_ST
0x10  INT_ENA
0x14  INT_CLR
0x18  CONF0              PHY/clock config
0x20+ IN_EP0_ST etc.     diagnostics
```

### 2. The EP1 + WR_DONE TX protocol

Decoded from the IDF `usb_serial_jtag_ll.h` (HAL layer) source:
1. **Write** the byte to `EP1` register.
2. **Set** `EP1_CONF.WR_DONE` bit (write 1, hardware clears).
3. Silicon commits the byte to the USB TX FIFO and eventually
   ships it over USB.
4. `EP1_CONF.SERIAL_IN_EMPTY` indicates FIFO has room.

This is similar to a "single-byte FIFO with handshake" — not a
streaming UART. IDF's `usb_serial_jtag_write_bytes()` calls this
in a loop with timeout.

Our skeleton emits the JSON event on the WR_DONE pulse (treating
each pulse as a committed byte). Real silicon also queues the
byte for USB transmission; we skip that part (no USB host
emulation).

### 3. Status flag synthesis

Three status flags in EP1_CONF affect guest code:
- **SERIAL_IN_EMPTY** (bit 1): TX FIFO empty / has room. Guest
  polls before writing. We always report `1` so writes never
  block.
- **OUT_DATA_AVAIL** (bit 2): host wrote a byte we should read.
  We report `0` (no RX) since no USB host emulation.
- **WR_DONE** (bit 0): write-1-to-trigger, hardware auto-clears.
  Read-back during the trigger window shows 0.

### 4. eFuse DIS_USB_SERIAL_JTAG wiring

Same `disabled` field pattern as Phase 2.CC TWAI:
```c
ms->usj.disabled = esp32p4_efuse_get_dis_usb_serial_jtag(&ms->efuse);
```

When `disabled`:
- All MMIO reads return 0 — matches "no clock applied" silicon.
- All MMIO writes drop silently.
- Self-test prints "skipped — eFuse DIS_USB_SERIAL_JTAG=1" to
  stderr and returns immediately.

This is the **third TWAI-pattern peripheral disable** (after
TWAI in Phase 2.CC). Pattern is now established + reusable.

### 5. Smart_stub overlay priority

The existing
`create_unimplemented_device("esp32p4.usb_serial_jtag", 0x500D2000, 0x1000)`
lives at priority 1. The new peripheral overlays at priority 2
— so reads/writes hit the new code first, smart_stub becomes a
fallback (in practice never reached because the new region
covers the full 0x1000).

Could also have removed the smart_stub entry, but leaving it
preserves the pattern from Phase 2.CP (SHA over Phase 2.I.sha
stub) — safer rollback if something breaks.

### 6. Self-test design

Picked "VelxioP4" as the self-test payload (8 bytes, all ASCII
printable, identifies the emulator). Same shape as the Phase 2.AZ
UART self-test that writes "U1" — short, distinguishable,
human-readable.

For each byte:
1. Write to EP1 register (4-byte access, low byte = data byte).
2. Write `WR_DONE | 0` to EP1_CONF (the pulse + auto-clear).

This is the silicon-correct flow — IDF's `usb_serial_jtag_write_bytes()`
does the same thing per byte (with timeout polling between calls
which we skip since SERIAL_IN_EMPTY is always 1).

## Lo que SÍ funcionó

1. ✅ Build clean — new files compiled
   (`hw_char_esp32p4_usb_serial_jtag.c.o`), meson reconfig
   automatic.
2. ✅ Default boot emits 8 `usb_jtag_tx` events with the
   exact bytes spelling "VelxioP4" — verified via grep + ASCII
   decode.
3. ✅ stderr trace shows the silicon-correct sequence
   (TX #1..#8 with byte + ASCII char).
4. ✅ `VELXIO_EFUSE_DIS_USB_SERIAL_JTAG=1` produces 0 events
   + "self-test skipped" stderr — eFuse gate works.
5. ✅ No regression on other peripherals (5 crypto events
   from HMAC + AES + SHA still fire).
6. ✅ Smart_stub overlay priority works — overlay priority 2
   takes precedence over the existing priority 1 smart_stub.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **No real USB host emulation**: would need a full USB device
   stack (descriptors, control transfers, OUT endpoint host
   bytes). Significant work for low Arduino-sketch ROI. The
   JSON event stream is what matters for the frontend.

2. **SERIAL_IN_EMPTY always = 1**: avoids modeling a real TX
   FIFO (which would need depth tracking + timer-driven
   draining). Guest writes never block. Real silicon may
   throttle if the host doesn't pull bytes fast enough; we
   don't model that.

3. **OUT_DATA_AVAIL always = 0**: no host RX. Arduino sketches
   doing `Serial.read()` would loop forever. If the frontend
   wants RX support, would need a Phase 2.CR.next adding a
   reverse channel (similar to Phase 2.X.input for GPIO).

4. **WR_DONE auto-clear**: silicon clears it once the byte is
   committed. Our model clears immediately since there's no
   real transmission delay.

5. **No CLIC IRQ wiring**: USB Serial/JTAG has 4 interrupt
   sources (TX_DONE, RX_DONE, etc.) per TRM § 51.5. Skipping
   IRQ for now keeps the skeleton small; future phase can
   wire to an unused CLIC cause line (cause 31 was the last
   one wired in Phase 2.BZ).

6. **Overlay priority 2 vs deleting smart_stub**: safer to
   overlay. Matches the Phase 2.CP pattern. If the new
   peripheral has a bug at boot, the smart_stub remains as
   a fallback.

## Lessons learned

1. **TRM table-of-contents is a useful navigator**. The
   `_TRM_TOC.txt` file in specs/ has all chapter titles
   indexed; grepping it for "USB Serial" / "RSA" / "Secure
   Boot" surfaces missing peripherals quickly.

2. **The eFuse → peripheral disable pattern scales** — third
   peripheral (after TWAI in Phase 2.CC) using the same
   `disabled` field + `if (disabled) return 0` pattern. The
   pattern is uniform enough that future USB / I2S / etc.
   peripherals can follow it without thinking.

3. **JSON event naming consistency matters**. `usb_jtag_tx`
   parallels `uart_tx` (Phase 2.AW). Frontend code that
   renders TX bytes can use a uniform structure across both
   peripheral types.

4. **Self-test payload as emulator branding**. "VelxioP4" in
   the boot trace makes it immediately visible which emulator
   is running — useful for screenshots and demos. Real
   Arduino sketches will overwrite it on their own first
   `Serial.print()`.

## Implementación final

### New files

- `include/hw/char/esp32p4_usb_serial_jtag.h` — type def +
  register offsets + state struct + self-test declaration.
- `hw/char/esp32p4_usb_serial_jtag.c` — read/write handlers
  + WR_DONE trigger + JSON emission + reset + self-test.

### `hw/char/meson.build`

- Added `'esp32p4_usb_serial_jtag.c'` to the
  `CONFIG_RISCV_ESP32P4` source list.

### `hw/riscv/esp32p4.c`

- New `#include "hw/char/esp32p4_usb_serial_jtag.h"`.
- New `ESP32P4UsbSerialJtagState usj` field on machine state.
- New init block at `0x500D2000` (overlay priority 2 over the
  Phase 2.I smart_stub at priority 1).
- Wires `disabled = esp32p4_efuse_get_dis_usb_serial_jtag(...)`
  — closes the Phase 2.CC documentation-only gap.
- Self-test fires "VelxioP4" via EP1 + WR_DONE.

## Estado consolidado (post-2.CR)

USB peripheral inventory:

| Peripheral | Base | Status | Phase |
|------------|------|--------|-------|
| USB 2.0 HS (USB_OTG) | 0x50000000 | unimplemented stub | (out of scope) |
| USB 1.1 FS | 0x50040000 | unimplemented stub | (out of scope) |
| USB WRAP | 0x50080000 | unimplemented stub | n/a |
| **USB Serial/JTAG** | **0x500D2000** | **skeleton + eFuse gate** | **2.CR** |

eFuse → peripheral clock-gate inventory:

| eFuse field | Phase | Peripheral disabled |
|-------------|-------|---------------------|
| DIS_TWAI | 2.CC | all 3 TWAI ports |
| **DIS_USB_SERIAL_JTAG** | **2.CR** | **USB Serial/JTAG (this phase)** |
| DIS_USB_JTAG | (deferred) | (no JTAG-only peripheral modeled) |

JSON event types: **34** (chip_info=29, ssd1306=30, hmac=31,
aes=32, sha=33, **usb_jtag_tx=34**).

## 80-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.CP  | Standalone SHA peripheral                               |
| 2.CQ  | eFuse BLOCK4-9 key material                             |
| **2.CR** | **USB Serial/JTAG peripheral + DIS_USB_SERIAL_JTAG wiring** |

**80 phases milestone**. Crypto + USB inventory expanding.
DIS_USB_JTAG (the other half of Phase 2.CC's USB-disable pair)
remains documentation-only because no JTAG bridge peripheral
exists yet — JTAG is currently routed through the CPU's DM
implementation, not as a separate MMIO peripheral.

## Próximas direcciones

- **USB Serial/JTAG RX path** — reverse channel from frontend
  to emulator, mirrors Phase 2.X.input pattern for GPIO. Would
  let Arduino sketches read bytes sent by the frontend.
- **USB Serial/JTAG IRQ wiring** — 4 IRQ sources per TRM §
  51.5; would need a CLIC cause line (extended CLIC since
  causes 17-31 are used).
- **JTAG bridge peripheral** — would wire DIS_PAD_JTAG +
  SOFT_DIS_JTAG + DIS_USB_JTAG end-to-end.
- **Multi-block HMAC** (SET_MESSAGE_ING/END).
- **AES-CBC/AES-GCM block modes**.
- **XTS-AES for flash encryption** (KEY_PURPOSE_2/3/4 +
  BLOCK4-9 keys from Phase 2.CQ).
- **RSA peripheral** (TRM 25).
- **ECC peripheral** (TRM 26).
- **MS5611 / W5500 / MFRC522** sensors/SPI responders.
- **UART IRQ** via interrupt matrix.
- **Real PWM** waveform via LEDC.
- **FreeRTOS** scheduler resurrection.
