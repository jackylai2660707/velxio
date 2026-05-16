# Phase 2.CD — per-instance SPI responder dispatch (SPI2=ILI9341, SPI3=SD)

**Estado**: ✅ done — closes the Phase 2.BZ TODO. SPI2 and SPI3
now produce **distinguishable** spi_rx responses corresponding
to different attached devices, matching how real Arduino
sketches wire dual SPI controllers (display on SPI2, SD card
on SPI3).

Live verification (2026-05-16):

```json
{"event":"spi_rx","port":2,"cmd":4,  "response":37697}   ← ILI9341 RDDID → 0x9341
{"event":"spi_rx","port":3,"cmd":64, "response":1}       ← SD CMD0 → R1=0x01 (idle)
```

Same MMIO class, same self-test, **different responder**.
Phase 2.BZ generated identical responses for both ports because
the responder was hardcoded to ILI9341 — Phase 2.CD adds a
dispatcher and lets the machine init configure each controller
independently.

## Goal

Mirror the I2C 4-sensor dispatcher pattern (Phase 2.BD/2.BE)
on the SPI side. The I2C peripheral routes responder selection
by the 7-bit slave address embedded in the FIFO data:
0x76/77 → BMP280, 0x68/69 → MPU-6050, 0x1E → HMC5883L,
0x29 → VL53L0X. Each I2C controller transparently serves all 4
devices because the slave address travels with the transaction.

SPI is different: there's no on-bus address. Each SPI
controller serves **one** device at a time (selected by CS pin
on real hardware). So the responder is a property of the
**controller instance**, set at machine init based on what the
sketch wires to that controller. This matches real-world
Arduino practice: SPI2 typically gets the display, SPI3 gets
the SD card (or W5500 ethernet, or whatever else).

Phase 2.BZ already added SPI3 with port_num=3 and shared the
ILI9341 responder. Phase 2.CD finishes the job: per-instance
dispatch with a new SD-card responder for SPI3.

## Lo que SE INVESTIGÓ

### 1. Responder enum + struct field

New enum `ESP32P4SpiResponderKind`:
- `ESP32P4_SPI_RESPONDER_NONE` (0, default)
- `ESP32P4_SPI_RESPONDER_ILI9341` (display)
- `ESP32P4_SPI_RESPONDER_SD` (SD card)

New `responder_kind` field on `ESP32P4SpiState`. Machine init
sets it once before the self-test fires; no runtime mutation.

### 2. SD card SPI-mode command format

SD over SPI sends commands as 6-byte frames: `[0x40 | idx][arg3][arg2][arg1][arg0][crc]`. Bit 6 is always set (`0x40`),
so SD command bytes occupy 0x40-0x7F. After each command, the
card returns a 1-byte R1 response; some commands return
additional payload (R3/R7 for OCR, interface conditions).

Minimum command set for Arduino `SD.begin()`:

| CMD | Byte | Name | Response |
|-----|------|------|----------|
| CMD0 | 0x40 | GO_IDLE_STATE | R1 = 0x01 (idle) |
| CMD8 | 0x48 | SEND_IF_COND | R1 + 4-byte echo `0x000001AA` |
| CMD55 | 0x77 | APP_CMD (prefix) | R1 = 0x01 (latch ACMD flag) |
| ACMD41 | 0x69 (after CMD55) | SD_SEND_OP_COND | R1 = 0x00 (ready) |
| CMD58 | 0x7A | READ_OCR | R1=0 + 32-bit OCR (CCS=1 SDHC) |
| other | — | — | R1 = 0x05 (illegal command) |

The SD responder also tracks an `sd_expect_acmd` flag: CMD55
sets it, the next command consumes it. This is the minimum
state needed to distinguish ACMD41 from a regular CMD41.

### 3. The 32-bit response packing

The dispatcher returns a `uint32_t` because the existing
ILI9341 responder did. For SD:
- Byte 0 = R1
- Bytes 1-3 = payload bytes (little-endian)

CMD8's response `0x01u | (0x01u << 24) | (0xAAu << 16)`
encodes:
- Byte 0 = R1 = 0x01
- Byte 1 = 0x00 (reserved)
- Byte 2 = voltage check pattern echo = 0xAA
- Byte 3 = voltage range = 0x01

Real SD sends this as 5 bytes [R1=0x01, 0x00, 0x00, 0x01, 0xAA]
but our 32-bit packing covers the first 4. Arduino's SD library
reads at most 4 bytes for the R7 response (R1 + the 0x01AA
echo), so 4 bytes is sufficient.

### 4. Self-test probe selection

Existing self-test fires ILI9341 RDDID (0x04) to exercise the
responder. For SD, RDDID makes no sense — the SD responder
would hit the `default` case and return R1=0x05 (illegal).

Made the self-test responder-aware: SD self-tests fire CMD0
(0x40) to exercise the SD path. ILI9341 self-tests continue to
fire RDDID (0x04). Both produce spi_rx events but with
distinguishable values (0x9341 vs 0x01), proving the dispatch
works.

### 5. No backwards-incompatible changes

Existing call sites (`esp32p4_spi_self_test(&ms->spi2)`) keep
working identically because:
- `responder_kind` defaults to 0 (`NONE`) on zero-initialized
  struct.
- Machine init explicitly sets SPI2 to ILI9341 (matches Phase
  2.AU behavior).
- SPI3 is the only instance changing behavior (from shared
  ILI9341 to SD).

So the only **visible** difference vs Phase 2.BZ is: SPI3's
spi_rx response is now `1` (SD CMD0 R1) instead of `37697`
(ILI9341 RDDID). All other SPI behavior unchanged.

## Lo que SÍ funcionó

1. ✅ Build clean — three files compiled
   (`hw_ssi_esp32p4_spi.c.o`, `hw_riscv_esp32p4.c.o`,
   `hw_nvram_esp32p4_efuse.c.o` rebuilt as transitive header dep).
2. ✅ Boot trace shows two distinguishable spi_rx events:
   - port=2, cmd=4, response=37697 (`0x9341`) — ILI9341
   - port=3, cmd=64, response=1 (R1 idle) — SD
3. ✅ Other peripherals untouched.
4. ✅ Self-test dispatcher correctly picks RDDID for ILI9341,
   CMD0 for SD.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Enum-based dispatch vs function-pointer table**: chose
   enum + switch because it's 5 LOC vs a function-pointer
   table's 30+. Switch-based dispatch keeps the responder
   functions visible to the compiler for inlining and stays
   readable when adding 2-3 future responders (W5500, ENC28J60).
   If the responder count grows past ~6, refactor to a table.

2. **SD CMD58 OCR packing** uses `0xC0` (busy bit + CCS=1 for
   SDHC) in the high byte. Real OCR has more bits but the
   Arduino driver primarily checks CCS to decide SDHC vs SDSC
   card capacity addressing.

3. **Self-test probe selection inside self-test, not at call
   site**: the self-test function itself knows what probe is
   meaningful for each responder kind. Keeping the dispatch
   inside `esp32p4_spi_self_test()` avoids leaking
   responder-specific knowledge into machine init.

4. **No state-erase reset on responder change**: the
   `sd_expect_acmd` flag is initialized via QEMU's automatic
   zeroing of the struct. No explicit reset needed because
   responder_kind is immutable after machine init.

5. **Single 32-bit response field for both responders**: the
   ILI9341 contract was already "return up to 4 bytes packed
   into uint32_t". SD fits naturally because R1 + 3 payload
   bytes = 4 bytes. R7 returns 5 bytes on real silicon but the
   Arduino library only consumes 4.

## Lessons learned

1. **Per-controller responder dispatch matches SPI semantics
   better than per-address dispatch (I2C-style)**. SPI has no
   on-bus address — the CS pin selects the slave physically.
   So the controller "knows" which device it talks to from
   wiring, not from the protocol. The emulator mirrors this by
   making responder_kind a per-controller property.

2. **Enum dispatch scales gracefully to a handful of responders**.
   Adding a 3rd or 4th (W5500, MFRC522 RFID) means adding 1
   enum value + 1 responder function + 1 case in the
   dispatcher. ~30 LOC per new device.

3. **The Phase 2.BZ shared-responder workaround was correctly
   identified as a future-refinement TODO** rather than a
   blocker. Reading the 2.BZ doc made this phase obvious — the
   solution shape was already documented, just needed
   implementing.

## Implementación final

### `include/hw/ssi/esp32p4_spi.h`

- New enum `ESP32P4SpiResponderKind { NONE, ILI9341, SD }`.
- New fields on `ESP32P4SpiState`:
  - `responder_kind` (enum value)
  - `sd_expect_acmd` (bool — tracks CMD55-then-ACMD state)

### `hw/ssi/esp32p4_spi.c`

- New `esp32p4_spi_sd_response()` function — handles CMD0,
  CMD8, CMD55, ACMD41 (gated on `sd_expect_acmd`), CMD58,
  default → 0x05.
- New `esp32p4_spi_dispatch_response()` — switches on
  `s->responder_kind`, calls the per-device function.
- `esp32p4_spi_fire_transaction()` switched from direct
  ILI9341 call to dispatcher.
- `esp32p4_spi_self_test()` switched probe command based on
  responder_kind (RDDID for ILI9341, CMD0 for SD).

### `hw/riscv/esp32p4.c`

- `ms->spi2.responder_kind = ESP32P4_SPI_RESPONDER_ILI9341;`
  in the SPI2 init block.
- `ms->spi3.responder_kind = ESP32P4_SPI_RESPONDER_SD;` in the
  SPI3 init block.

## Estado consolidado (post-2.CD)

SPI responder inventory:

| Controller | port_num | Responder | Probe (self-test) | Response |
|------------|----------|-----------|-------------------|----------|
| SPI2 | 2 | ILI9341 | RDDID (0x04) | 0x9341 |
| **SPI3** | **3** | **SD** | **CMD0 (0x40)** | **0x01** |

JSON event types: **29** (no new type — same `spi_rx` event,
just different values per port).

## 66-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BZ  | SPI3 instantiation (shared ILI9341 responder — known limitation) |
| 2.CA  | eFuse wafer + pkg layout silicon fix                    |
| 2.CB  | chip_info self-test                                      |
| 2.CC  | DIS_TWAI eFuse field + TWAI peripheral disable           |
| **2.CD** | **Per-instance SPI responder dispatch (SPI2=ILI9341, SPI3=SD)** |

## Próximas direcciones

- **Extend SD responder** to handle CMD17/24 (single block
  read/write) — would enable basic SD.open() / .read() /
  .write() flows.
- **W5500 ethernet responder** for the Arduino Ethernet
  library on SPI2/3.
- **MFRC522 RFID responder** for RC522 reader Arduino sketches.
- **DIS_USB_JTAG / DIS_USB_SERIAL_JTAG** wiring once USB
  peripheral models exist.
- **KEY_PURPOSE** fields for crypto routing.
- **UART IRQ** (QOM class-override).
- **Real PWM** waveform on GPIO via LEDC.
- **BH1750/SHT31/CCS811** I2C sensors.
- **FreeRTOS** scheduler.
- **CLIC cause budget exhausted** at cause 31.
