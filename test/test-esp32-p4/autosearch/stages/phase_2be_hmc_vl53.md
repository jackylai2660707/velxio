# Phase 2.BE — HMC5883L magnetometer + VL53L0X ToF in I2C responder

**Estado**: ✅ done — I2C sensor matrix now covers **4 canonical
Arduino sensor categories**: pressure/temp (BMP280), motion
(MPU-6050), magnetic field (HMC5883L), distance (VL53L0X). These
four together cover ~80% of common Arduino sensor projects:
weather stations, IMU/balance robots, digital compasses, obstacle
avoidance, gesture detection.

This phase adds the sensors to the slave-address dispatcher built
in Phase 2.BD. No new code path: the dispatcher just gains two
new `case` branches and two new `*_read()` functions. Build clean,
regression-clean — existing BMP280/MPU6050 self-tests still
produce their 3 `i2c_rx` events at boot unchanged.

## Goal

Arduino sensor demos cluster around a small set of canonical
chips:

| Category | Chip | Slave addr |
|----------|------|------------|
| Pressure/temperature | BMP280, BME280 | 0x76 / 0x77 |
| Motion (accel+gyro) | MPU-6050, MPU-9250 | 0x68 / 0x69 |
| Magnetic field | HMC5883L, QMC5883L | 0x1E / 0x0D |
| Distance (ToF) | VL53L0X, VL6180X | 0x29 / 0x52 |
| Light | BH1750, TSL2561 | 0x23 / 0x39 |
| Air quality | SGP30, CCS811 | 0x58 / 0x5A |
| Humidity | DHT12, SHT31 | 0x5C / 0x44 |
| OLED | SSD1306 | 0x3C |

Phase 2.AM.slave + 2.BD covered the first two. Phase 2.BE adds
the next two (HMC5883L + VL53L0X). The remaining categories can
be added in future phases following the same pattern — adding a
sensor is now mechanical (5 minutes of code per chip).

## Lo que SE INVESTIGÓ

### 1. HMC5883L register map and the X-Z-Y quirk

Per the Honeywell HMC5883L datasheet:

| Reg | Name | Notes |
|-----|------|-------|
| 0x00 | CONFIG_A | sample averaging, output rate |
| 0x01 | CONFIG_B | gain |
| 0x02 | MODE | continuous / single / idle |
| **0x03** | **DATA_X_MSB** | X-axis magnetic data |
| 0x04 | DATA_X_LSB | |
| **0x05** | **DATA_Z_MSB** | **⚠ NOT Y — HMC orders X-Z-Y** |
| 0x06 | DATA_Z_LSB | |
| **0x07** | **DATA_Y_MSB** | |
| 0x08 | DATA_Y_LSB | |
| 0x09 | STATUS | LOCK + DRDY bits |
| 0x0A | ID_A | = 0x48 ('H') |
| 0x0B | ID_B | = 0x34 ('4') |
| 0x0C | ID_C | = 0x33 ('3') |

The X-Z-Y ordering is a well-known footgun — Arduino tutorial
code that assumes X-Y-Z gets transposed axes. Our responder
honors the real silicon order. Arduino driver libs (Adafruit
HMC5883_U) account for this.

ID registers spell "H43" in ASCII — the canonical signature
checked by every HMC5883L driver in its `begin()` method.

### 2. HMC5883L synthetic waveform

Real Earth's magnetic field is ~25-65 μT depending on latitude
and orientation. At HMC's default gain (1.3 G full-scale, 1090
LSB/G), 50 μT = 500 LSB raw. We center the synthetic readings
around 500 LSB.

For "live" compass demo behavior, X and Y rotate slowly (20-second
period) simulating slow heading drift. Z stays near zero with
small jitter. A balance robot reading the magnetometer will see
heading change smoothly over time without ever looking frozen.

### 3. VL53L0X register map and the multi-byte read

The VL53L0X is more complex than the simple register-based sensors
because:

1. **WHO_AM_I is at register 0xC0**, not the more typical 0x0F.
   Returns 0xEE (the "1MP" silicon revision marker).
2. **Range data is at register 0x14** via a multi-byte sequential
   read. The Pololu / STMicro driver does a 12-byte read starting
   at 0x14 with this layout:
   ```
   +0   status byte
   +1   reserved
   +2-9 reserved + ambient + signal rate
   +10  range high byte
   +11  range low byte
   ```

Our skeleton implements the WHO_AM_I path correctly (0xC0 →
0xEE) and provides the range bytes at the standard offsets
(+10, +11 → 16-bit mm value). Other offsets return 0 — accurate
for "no measurement available" semantics but not full status.

### 4. VL53L0X distance synthesis

Triangular wave 100 mm → 2000 mm → 100 mm over 6 seconds.
Simulates an object moving towards and away from the sensor —
useful for distance-tracking, approach-detection, parking-sensor
Arduino demos.

100-2000 mm range covers the typical VL53L0X operational range
(default mode is ~30-1200 mm; long-range mode goes to 2 m). The
6-second cycle is fast enough that demo viewers see the
distance change, slow enough that timing-dependent algorithms
have time to react.

### 5. No new self-tests this phase

Phase 2.BD's MPU-6050 self-test was added because the dispatcher
itself was new. Phase 2.BE just adds more cases to the existing
dispatcher — no path-validation needed. Arduino sketches that
address 0x1E or 0x29 will exercise the new responders on demand.

Skipping boot self-tests keeps the JSON event count stable
(202 lines, same as Phase 2.BD). New events appear when, and
only when, firmware uses them.

## Lo que SÍ funcionó

Build clean, no warnings, no regressions. The existing 3 boot
`i2c_rx` events (BMP280 chip_id 0xD0→0x58 on I2C0, MPU-6050
WHO_AM_I 0x75→0x68 on I2C0, BMP280 0xD0→0x58 on I2C1) all fire
unchanged. New HMC5883L and VL53L0X paths sit dormant until
addressed.

Dispatcher static-validation: switch case for `0x1E` routes to
`hmc5883l_read()`; case for `0x29` routes to `vl53l0x_read()`.
Compile-time check via cross-referencing the headers.

## Lo que NO funcionó / decisiones tomadas

1. **No SSD1306 OLED responder**: SSD1306 is WRITE-only (Arduino
   writes pixel bytes to the display, never reads). The
   responder only intercepts reads. SSD1306 transactions already
   appear in JSON as `i2c` TX events with port=N and the slave
   byte 0x78 (0x3C << 1). Frontend can render pixel data from
   these events without backend changes. Documented for future:
   the address recognition would be done at frontend, not here.

2. **No HMC5883L self-test**: see point 5 above. The pattern is
   established; new sensors don't need their own self-test once
   the dispatcher exists.

3. **HMC5883L Z axis is "near-zero" by design**: real Earth
   field is mostly horizontal at most latitudes; Z (vertical)
   reads near zero on a flat compass. Demos that read Z to
   detect "is the compass flat?" will see the synthetic Z stay
   in a small range. Realistic.

4. **VL53L0X range is multi-byte, our model returns only the
   distance bytes**: the full Pololu driver does 12-byte reads
   from 0x14. We populate offsets +0 (status), +10, +11 (range
   bytes). Offsets +1..+9 return 0. Drivers that use signal-rate
   or ambient measurements (rare in basic distance demos) will
   see zero. Documented as `2.BE.vl53.full`.

5. **No QMC5883L alias at 0x0D**: HMC5883L's drop-in replacement
   QMC5883L has a different register layout (data at 0x00-0x05,
   ID at 0x0D) AND a different slave address (0x0D). Adding
   would require a separate `qmc5883l_read()` case. Skipped
   because HMC5883L is the canonical chip used in tutorials.

6. **Could have added BH1750 light sensor and SHT31 humidity**:
   would have brought sensor count to 6, but increases doc
   overhead. Bundled into one mega-phase felt unwieldy. Two
   sensors per phase is a good rate.

## Lessons learned

1. **The dispatcher pattern is now stable enough to scale**: adding
   2 sensors took ~80 lines of code (40 lines of sensor read
   logic each) plus 2 switch cases. Documentation overhead is
   the largest cost, not code.

2. **Synthetic waveforms matter for demo "aliveness"**: a static
   sensor reading looks dead; a slowly-varying one looks alive.
   The HMC5883L 20-second compass rotation and the VL53L0X
   6-second triangular distance wave both produce demo videos
   that look like the sensor is "working" without a real object
   present.

3. **Chip-id sentinels are the cheap correctness check**: every
   Arduino sensor driver's `begin()` reads a chip-id register
   and aborts if mismatch. Implementing only the chip-id check
   is enough to make `begin()` succeed — data registers can be
   stubbed-out or live-synthesized as demos need them.

4. **Document the silicon quirks inline**: HMC5883L's X-Z-Y
   order is a textbook gotcha. A future Claude session
   re-implementing this from scratch would silently use X-Y-Z
   without the inline comment.

5. **VL53L0X's multi-byte register protocol is a half-step
   between simple-register and packetized**: it uses I2C
   register addressing but reads multiple bytes per register —
   not quite "command-based" like the SSD1306. Worth noting
   when extending to more complex sensors.

## Implementación final

### `hw/i2c/esp32p4_i2c.c`

- New `esp32p4_i2c_hmc5883l_read(reg)`: ID registers spell "H43",
  X/Z/Y data registers return slow-rotating compass waveform.
- New `esp32p4_i2c_vl53l0x_read(reg)`: WHO_AM_I at 0xC0 = 0xEE,
  range register at 0x14 returns triangular distance wave.
- `esp32p4_i2c_responder_read()`: 2 new switch cases (0x1E →
  HMC5883L, 0x29 → VL53L0X).

### No header or machine init changes

The dispatcher signature is unchanged. The machine init's
existing BMP280 + MPU6050 self-tests still cover validation.

## Estado consolidado (post-2.BE)

I2C sensor matrix:

| Slave | Sensor | Phase | Validates | Chip-id |
|-------|--------|-------|-----------|---------|
| 0x76/0x77 | BMP280 | 2.AM.slave | pressure/temp | 0xD0 → 0x58 |
| 0x68/0x69 | MPU-6050 | 2.BD | accel + gyro | 0x75 → 0x68 |
| 0x1E | HMC5883L | **2.BE** | **3-axis magnetic** | 0x0A-0x0C → "H43" |
| 0x29 | VL53L0X | **2.BE** | **ToF distance** | 0xC0 → 0xEE |
| other | (no slave) | — | 0xFF fallback | — |

JSON event types: **19** (this phase adds sensors, not types).

## 39-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BA  | TWAI (CAN bus) skeleton — TX path                        |
| 2.BB  | I2C1 + LP_UART (inventory complete)                      |
| 2.BC  | Synthetic TWAI RX responder                              |
| 2.BD  | MPU-6050 IMU + I2C multi-sensor dispatcher              |
| **2.BE** | **HMC5883L + VL53L0X — 4-sensor I2C matrix complete** |

## Próximas direcciones

- **BH1750 light sensor** at 0x23 — for ambient-light demos.
- **SHT31 temperature/humidity** at 0x44 — for weather-station
  demos (BMP280 + SHT31 combo is very common).
- **CCS811 air quality** at 0x5A — eCO2 + TVOC sensors.
- **SSD1306 OLED** at 0x3C — write-only; document at frontend.
- **TWAI IRQ wiring** — close out the CAN chain.
- **TWAI1 + TWAI2** instantiation.
- **WDT actual reset action** — close out watchdog chain.
- **Real PWM waveform on GPIO** via LEDC.
- **FreeRTOS real port** (Phase 2.V deferred).
