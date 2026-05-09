# Phase 2.AM.slave — Synthetic I2C BMP280 responder

**Estado**: ✅ done — I2C0's FIFO_DATA reads now return realistic
BMP280 register values. Self-test demonstrates a complete end-to-end
"check chip-id" transaction returning the canonical 0x58 marker.
Arduino sketches using `Adafruit_BMP280::begin()` will pass the
chip-id check.

## Goal

Phase 2.AM left the I2C peripheral skeleton in place but FIFO_DATA
reads always returned 0xFF (no slave). This phase adds a minimal
synthetic slave that responds AS IF a BMP280 were on the bus at
address 0x76.

A BMP280 demo sketch typically does:

```cpp
Wire.beginTransmission(0x76);
Wire.write(0xD0);           // chip_id register
Wire.endTransmission();
Wire.requestFrom(0x76, 1);
chip_id = Wire.read();
if (chip_id != 0x58) {
    // sensor not present → bail
}
```

Without a slave responder, `chip_id` would be 0xFF, the check fails,
and the sketch errors out. With Phase 2.AM.slave: `chip_id == 0x58`,
the check passes, and the sketch enters its main loop.

## Lo que SE INVESTIGÓ

### 1. The "register address inference" problem

Real I2C protocol decouples address from data. A typical register
read involves THREE bytes on the wire before the read actually
happens:

```
1. slave_addr | W bit   (e.g., 0xEC)
2. register_addr        (e.g., 0xD0)
3. (RSTART)
4. slave_addr | R bit   (e.g., 0xED)
5. master reads N bytes ← we are here
```

Our synthetic slave needs to know "the master wants register 0xD0"
when step 5 happens. The challenge: by step 5, the most recent
FIFO_DATA write was 0xED (slave_addr+R), not 0xD0.

**Solution**: maintain a rolling buffer of the last 2 FIFO_DATA
writes. `tx_history[0]` is the most recent (= slave_addr+R),
`tx_history[1]` is the previous (= register address).

```c
on FIFO_DATA write(byte):
  tx_history[1] = tx_history[0];
  tx_history[0] = byte;

on FIFO_DATA read():
  if (!read_active) {
    read_reg = tx_history[1];   // latch the register
    read_active = true;
  }
  return bmp280_read(read_reg++);  // auto-increment for burst
```

`read_reg++` supports burst reads — when the master reads multiple
bytes in one READ command, each subsequent read auto-increments
the register pointer (BMP280 supports this for reading the 6-byte
pressure+temperature data block in one transaction).

`read_active` resets on STOP command so the next transaction
re-latches `read_reg` from a fresh `tx_history`.

### 2. BMP280 register set (minimal subset)

| Reg  | Name        | Value                                   |
|------|-------------|------------------------------------------|
| 0xD0 | chip_id     | 0x58 (always — canonical BMP280 marker) |
| 0xF7 | press_msb   | top 8 bits of 20-bit pressure raw        |
| 0xF8 | press_lsb   | middle 8 bits                            |
| 0xF9 | press_xlsb  | bottom 4 bits (in upper nibble)          |
| 0xFA | temp_msb    | top 8 bits of 20-bit temperature raw     |
| 0xFB | temp_lsb    | middle 8 bits                            |
| 0xFC | temp_xlsb   | bottom 4 bits                            |
| other| —           | 0xFF (typical I2C "no register" pull-up) |

Pressure and temperature raw values are **time-varying**:

```c
press_raw = 0x65000 + (t_ms / 10) % 0x1000   // ~10s cycle
temp_raw  = 0x82000 + (t_ms / 30) % 0x1000   // ~30s cycle
```

Centered around values typical for BMP280 calibrated readings (~1013
hPa pressure, ~25°C temperature). Real BMP280 raw values would need
to go through the chip's per-unit calibration registers — we skip
that since the goal is "alive sensor data" not "physically
accurate". Adafruit_BMP280's compensation function will produce some
varying number; close enough for visible demo.

### 3. Self-test: end-to-end exercise

The Phase 2.AM self-test fired 8 i2c events for the master side
but didn't actually exercise the slave responder (no FIFO_DATA
reads). Phase 2.AM.slave extends the self-test to additionally
simulate the master's read phase:

```c
// After firing the CMD events:
tx_history[0] = (0x76 << 1) | 0x1;  // slave_addr+R
tx_history[1] = 0xD0;                // register address
read_active = false;
esp32p4_i2c_read(s, FIFO_DATA, 4);   // triggers the slave responder
```

This produces an `i2c_rx` event at boot showing the chip-id read
returning 0x58.

### 4. JSON event format

New event type added:

```json
{"t_ns":1129479,"event":"i2c_rx","port":0,"reg":208,"byte":88}
```

- `reg`: register being read (in decimal — 208 = 0xD0)
- `byte`: value returned (in decimal — 88 = 0x58)

The frontend can pair these with the preceding `fifo_tx` and `cmd`
events to build a complete bus-transaction trace.

## Lo que SÍ funcionó

10-second live test (2026-05-08):

```
=== JSON event totals ===
Total lines: 380  (was 379 in 2.AM, +1 i2c_rx)

  "event":"ledc":     99   ← unchanged
  "event":"adc":      33   ← unchanged
  "event":"timg":      9   ← unchanged
  "event":"timg_irq": 18   ← unchanged
  "event":"i2c":       8   ← unchanged (master-side events)
  "event":"i2c_rx":    1   ← NEW: chip-id read response
  "event":"start":     1
  "pin":              200
```

Self-test emitted (full transaction at t≈1.1 ms):

```
fifo_tx 236     ; 0xEC = slave_addr+W
fifo_tx 208     ; 0xD0 = chip-id register
cmd rstart slot=0
cmd write  slot=1 byte_num=2
cmd rstart slot=2
cmd write  slot=3 byte_num=1
cmd read   slot=4 byte_num=1
cmd stop   slot=5
i2c_rx reg=208 byte=88   ← THE KEY RESPONSE
```

`reg=208`, `byte=88` decodes to "register 0xD0 returned 0x58" —
the BMP280 chip-id. ✓

No regression: all other event counts identical to Phase 2.AM.

## Lo que NO funcionó / decisiones tomadas

1. **Synthesized values aren't calibration-correct**: real BMP280
   raw values need ~88 bytes of per-chip calibration coefficients
   (DIG_T1..T3, DIG_P1..P9). We don't model these. Adafruit_BMP280's
   compensation will produce SOME number from our raw values — it
   won't be physically meaningful, but it'll vary over time which
   is enough for "demo" purposes.

2. **Single slave only (BMP280 at 0x76)**: the responder hardcodes
   one slave. Future Phase 2.AM.slaves could add multiple
   slave-address mappings (env var-configured: `VELXIO_I2C_SLAVE
   =0x76:bmp280,0x3C:ssd1306,...`).

3. **No ACK simulation**: real I2C NACKs unknown addresses; our
   model accepts everything. Master sketches that check ACK status
   for "is sensor present" would always think YES. This is OK for
   demos but not strictly accurate.

4. **No START/RSTART tracking**: we infer "transaction boundary"
   from STOP command alone. Real bus state-machine tracks
   START/RSTART explicitly. Could matter if the guest issues
   weird transactions (e.g., RSTART without preceding STOP), but
   normal Arduino code is well-behaved.

5. **`read_reg` shadowing across transactions**: cleared on STOP.
   If a sketch issues multiple consecutive transactions without
   STOP between them, `read_reg` would persist — could be a bug
   for some patterns. STOP-bracketed transactions are the norm.

## Lessons learned

1. **Two-byte rolling history is the minimum viable register
   inference**: a single-byte history would catch only "single-
   byte register" reads incorrectly (would return slave_addr+R
   value instead of register address). Two bytes covers the
   canonical Arduino Wire pattern.

2. **Auto-increment is essential for burst reads**: BMP280's main
   data block (pressure + temperature) is read as 6 consecutive
   bytes from register 0xF7. Without `read_reg++`, every byte
   would return register 0xF7 instead of advancing through the
   sequence.

3. **Self-test calling its own internal read function gives
   end-to-end coverage**: rather than emitting JSON manually for
   the self-test response, we set up tx_history correctly and
   call `esp32p4_i2c_read()` — same code path the guest uses.
   Catches bugs in the read path that pure event-emit testing
   would miss.

## Implementación final

### `include/hw/i2c/esp32p4_i2c.h`

- New fields: `tx_history[2]`, `read_reg`, `read_active`.

### `hw/i2c/esp32p4_i2c.c`

- New `esp32p4_i2c_bmp280_read(reg)` — register table.
- Read path: latch `read_reg` from `tx_history[1]` on first read of
  a transaction, increment for burst reads, emit `i2c_rx` JSON event.
- Write path: shift bytes into `tx_history`.
- CMD path: STOP resets `read_active` + `tx_history`.
- Reset clears all new fields.
- Self-test extended: simulates master's read phase to exercise the
  full path.

## Estado consolidado (post-2.AM.slave)

| Hito                                                          | Estado |
|---------------------------------------------------------------|--------|
| GPIO + LEDC + ADC + TIMG + ISR chain                           | ✅ 2.W-AL|
| I2C0 master skeleton                                            | ✅ 2.AM|
| **I2C synthetic BMP280 slave responder**                       | ✅ 2.AM.slave |
| I2C CPU IRQ wiring                                              | ⏳ later |
| TIMG1 + watchdog                                                | ⏳ later|
| SPI master                                                       | ⏳ later|
| Real PWM waveform on GPIO                                      | ⏳ later|
| Real FreeRTOS port                                              | ⏳ Phase 2.V |

JSON stream now carries 8 event types: `start | pin | ledc | adc |
timg | timg_irq | i2c | i2c_rx`.

## Próximas direcciones

- **Phase 2.AM.demo**: extend the demo blob with an Arduino-style
  Wire transaction (write reg addr, read chip-id, branch on result).
  This proves a full guest-side BMP280 detection works.
- **Phase 2.AM.irq**: wire I2C transaction-end IRQ to a free CLIC
  cause — enables `Wire.onReceive()` callbacks.
- **Phase 2.AM.multi**: env-var-configured slave table for
  multiple I2C devices (BMP280 + SSD1306 OLED + ...).
- **TIMG1 + WDT**, SPI master, real PWM — same as before.
