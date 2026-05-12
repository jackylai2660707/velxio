# Phase 2.BD — MPU-6050 IMU added to I2C responder

**Estado**: ✅ done — the synthetic I2C responder now handles
BOTH BMP280 (pressure/temperature) and MPU-6050 (accelerometer /
gyroscope / temperature). Slave-address dispatch via
`tx_history[0] >> 1` routes reads to the correct sensor backend.
Foundation for Arduino IMU demos (GY-521, balance robots, drone
attitude estimation, gesture detection, step counting).

Log proof (2026-05-08): three `i2c_rx` events at boot proving the
dispatcher works:
```json
{"t_ns":654758,"event":"i2c_rx","port":0,"reg":208,"byte":88}   ← BMP280 0xD0 → 0x58
{"t_ns":657136,"event":"i2c_rx","port":0,"reg":117,"byte":104}  ← MPU6050 0x75 → 0x68
{"t_ns":756066,"event":"i2c_rx","port":1,"reg":208,"byte":88}   ← BMP280 0xD0 → 0x58 on I2C1
```

Decoded:
- reg=208 (0xD0), byte=88 (0x58) — BMP280 chip_id ✓
- reg=117 (0x75), byte=104 (0x68) — MPU-6050 WHO_AM_I ✓
- Both sensors return canonical identifiers — Arduino
  `Adafruit_BMP280` AND `Adafruit_MPU6050` chip-id checks both
  succeed.

## Goal

Phase 2.AM.slave added the BMP280 responder at slave 0x76,
opening the door for any Arduino I2C sensor demo. But:

1. **BMP280 is one sensor in a vast ecosystem**: motion sensors
   (MPU-6050, ICM-20948), magnetometers (HMC5883L), light sensors
   (BH1750), displays (SSD1306 OLED), expanders (PCF8574),
   ADCs/DACs (ADS1115, MCP4725) are all extremely common in
   Arduino projects.

2. **Single-sensor model artificially limits demos**: a sketch
   trying to read accelerometer data at slave 0x68 would get back
   0xFF (typical pull-up) — looking like "no sensor connected".

3. **Multi-sensor demos are mainstream**: weather stations
   combine pressure (BMP) + humidity (DHT/AHT) + air quality
   (SGP30). Robots combine IMU (MPU) + distance (VL53L0X) +
   compass (HMC). Without multi-sensor support, none of these
   patterns work in the emulator.

Phase 2.BD adds the second-most-common Arduino I2C sensor
(MPU-6050) and establishes the dispatcher pattern for adding
more in future phases.

## Lo que SE INVESTIGÓ

### 1. Slave address inference

The responder already tracks `tx_history[0]` (most recent
FIFO_DATA write) and `tx_history[1]` (previous). The canonical
Arduino Wire pattern leaves:
- `tx_history[0]` = slave_addr+R (the most-recent write before
  the RSTART for read phase)
- `tx_history[1]` = register address

So the slave 7-bit address = `tx_history[0] >> 1`. Strip the R/W
bit.

For Phase 2.BD, dispatcher:
```c
uint8_t slave_addr = s->tx_history[0] >> 1;
switch (slave_addr) {
case 0x76: case 0x77:  return bmp280_read(reg);
case 0x68: case 0x69:  return mpu6050_read(reg);
default:                return 0xFF;
}
```

The pairs (0x76/0x77 for BMP280, 0x68/0x69 for MPU-6050) match
the SDO/AD0 pin-strapping options on real silicon.

### 2. MPU-6050 register map essentials

Per the canonical datasheet (InvenSense MPU-6050 Product
Specification, Rev 3.4):

| Reg  | Name | Notes                          |
|------|------|--------------------------------|
| 0x3B | ACCEL_XOUT_H | accelerometer X high byte |
| 0x3C | ACCEL_XOUT_L | accelerometer X low byte |
| 0x3D | ACCEL_YOUT_H |                          |
| 0x3E | ACCEL_YOUT_L |                          |
| 0x3F | ACCEL_ZOUT_H |                          |
| 0x40 | ACCEL_ZOUT_L |                          |
| 0x41 | TEMP_OUT_H   | internal temp high byte  |
| 0x42 | TEMP_OUT_L   |                          |
| 0x43 | GYRO_XOUT_H  |                          |
| 0x44 | GYRO_XOUT_L  |                          |
| 0x45 | GYRO_YOUT_H  |                          |
| 0x46 | GYRO_YOUT_L  |                          |
| 0x47 | GYRO_ZOUT_H  |                          |
| 0x48 | GYRO_ZOUT_L  |                          |
| 0x6B | PWR_MGMT_1   | wake-up control          |
| 0x75 | WHO_AM_I     | chip ID = 0x68           |

The skeleton implements 0x3B-0x48 + 0x75. PWR_MGMT_1 returns 0
(Arduino driver writes 0 to wake the chip and never reads back,
so this is safe).

### 3. Synthesized motion waveforms

For believable Arduino demos, the values should LOOK alive (not
frozen). The skeleton synthesizes:

**Accelerometer X/Y**: sinusoidal in raw LSB, period ~10 s,
amplitude ±0.5g (±8192 LSB at the default ±2g full-scale where
1g = 16384 LSB). Phase-shifted between X and Y so a "circular
motion" pattern appears if both are plotted.

**Accelerometer Z**: stays near +16384 LSB (1g downward = device
flat on a table). Small jitter ±128 LSB to mimic vibration noise.

**Temperature**: MPU's internal-temp formula is `T_celsius =
(raw + 12421) / 340`. For ~25 °C we set raw to ≈ -3921 ±64. The
Adafruit driver applies the formula directly.

**Gyroscope**: small drift centered around zero, ±512 LSB
(roughly ±15.6 °/s at the default ±250 °/s full-scale). Each axis
phase-shifted independently.

All waveforms driven by `qemu_clock_get_ns(QEMU_CLOCK_REALTIME)`
so they're host-wall-clock-anchored — Arduino sketches reading
the IMU at any rate will see consistent motion patterns.

### 4. Two self-tests at boot

The machine init now calls TWO I2C0 self-tests:
1. `esp32p4_i2c_self_test(&ms->i2c0, 0x76)` → BMP280 ID read
2. `esp32p4_i2c_mpu6050_self_test(&ms->i2c0)` → MPU-6050 ID read

Plus the I2C1 self-test (`esp32p4_i2c_self_test(&ms->i2c1, 0x76)`)
from Phase 2.BB. Total: 3 boot self-tests across 2 buses, 3
distinct `i2c_rx` events proving both responders + both bus
instances work.

### 5. Single-byte STOP-less MPU self-test

The MPU self-test is shorter than the BMP280 one — only 3
events:
- TX byte: slave_addr+W = 0xD0
- TX byte: register 0x75
- CMD: READ 1 byte (slot 0, byte_num=1)

Skipped the full RSTART → WRITE → RSTART → WRITE → READ → STOP
sequence because the BMP280 self-test already exercises the full
CMD chain. The MPU test exists to validate the DISPATCHER, not
the CMD machinery — fewer events is fine.

## Lo que SÍ funcionó

Live test (2026-05-08), `i2c_rx` events:

```json
{"t_ns":654758,"event":"i2c_rx","port":0,"reg":208,"byte":88}
  → BMP280 chip_id: reg 0xD0 returned 0x58 ✓

{"t_ns":657136,"event":"i2c_rx","port":0,"reg":117,"byte":104}
  → MPU-6050 WHO_AM_I: reg 0x75 returned 0x68 ✓

{"t_ns":756066,"event":"i2c_rx","port":1,"reg":208,"byte":88}
  → BMP280 chip_id on I2C1: reg 0xD0 returned 0x58 ✓
```

Both responders fire from the SAME I2C device class. The
dispatcher correctly routes by slave address:
- 0x76 → bmp280_read() → returns 0x58 for reg 0xD0
- 0x68 → mpu6050_read() → returns 0x68 for reg 0x75

I2C event totals grew:
- Phase 2.BC: 18 i2c events, 2 i2c_rx events
- Phase 2.BD: 21 i2c events (added 3 from MPU self-test), 3 i2c_rx
  events (added 1 MPU)

Build clean, regression-clean — every other peripheral count
identical to Phase 2.BC within timing variance.

## Lo que NO funcionó / decisiones tomadas

1. **No MPU-6050 motion data validation at boot**: only WHO_AM_I
   is read. A future self-test could read ACCEL_ZOUT_H/L and
   verify the value is near +16384 (1g). Skipped — the dispatcher
   proof is the point of the self-test.

2. **PWR_MGMT_1 not properly modeled**: real MPU-6050 starts in
   sleep mode (bit 6 set). Arduino driver writes 0x00 to wake it,
   then reads sensors. We return 0x00 — meaning sketches that
   READ PWR_MGMT_1 to check sleep state will see "awake" before
   they write the wake command. Acceptable: no common Arduino
   driver does this check.

3. **No FIFO support**: real MPU-6050 has an internal sample
   FIFO at register 0x74. Some drivers use FIFO mode for high-
   rate sampling. Our model returns 0 for FIFO reads. Demos that
   use FIFO mode will read garbage. Documented for future:
   `2.BD.fifo`.

4. **No interrupt pin modeling**: real MPU-6050 has an INT pin
   that fires on motion / data-ready. We don't model this. Demos
   that wait for INT on a GPIO line will block forever. Could be
   added via a GPIO input wire if needed.

5. **No "magnetometer slave" support**: MPU-9250 (the upgrade)
   has an internal AK8963 magnetometer at slave 0x0C accessible
   via I2C master mode. Way out of scope for this phase. The
   plain MPU-6050 doesn't have it.

6. **Sensor-address mapping is hardcoded**: changing the slave
   address (e.g., MPU-6050 with AD0 = HIGH = 0x69 instead of
   0x68) requires recompiling. Could be an env var for
   convenience. Most Arduino demos pin to one default.

7. **Could have added SSD1306 OLED too**: 0x3C is the canonical
   OLED address; existing TX event tracking would already show
   pixel writes. Skipped — SSD1306 is WRITE-only, no responder
   logic needed, and the frontend can recognize 0x3C
   transactions as OLED pixels without any backend change.
   Documented in next directions.

## Lessons learned

1. **Slave-address dispatching scales linearly**: adding a third
   sensor (e.g., HMC5883L magnetometer at 0x1E) is now a 5-line
   addition: new switch case, new `_read()` function, optional
   self-test. The dispatcher pattern is established.

2. **WHO_AM_I-style sentinel registers are the cheap-validation
   pattern**: any I2C sensor worth using has a chip-id register
   that returns a known constant. The synthetic responder can
   minimum-implement that one register and Arduino driver `begin()`
   calls succeed. Then add data registers as demos need them.

3. **Pair the dispatcher with a per-sensor self-test**: the
   MPU-6050 path didn't exist 30 minutes before this commit;
   adding the boot self-test ensures any regression in the
   dispatcher (e.g., a future refactor moving the
   `tx_history[0] >> 1` lookup) immediately breaks visibly.

4. **Time-anchored sensor data is realistic**: using
   `qemu_clock_get_ns(QEMU_CLOCK_REALTIME)` to drive sensor
   waveforms means demos that show "live" motion graphs always
   look believable — no frozen readings, no synthetic noise that
   doesn't change.

5. **Different sensors have different "first read" patterns**:
   BMP280 driver init does the full RSTART → WRITE → RSTART →
   WRITE → READ chain; MPU-6050 Adafruit driver does a simpler
   WRITE+READ (no second RSTART). Our self-test for MPU uses the
   shorter pattern, matching what real Adafruit_MPU6050 actually
   does. Lesson: ship self-tests that mirror REAL driver behavior,
   not abstract worst-case CMD chains.

## Implementación final

### `hw/i2c/esp32p4_i2c.c`

- New `esp32p4_i2c_mpu6050_read(reg)`: returns canonical values
  for 0x3B-0x48 (accel/temp/gyro), 0x75 (WHO_AM_I=0x68), 0x00
  for unknown registers.
- New `esp32p4_i2c_responder_read(s, reg)`: dispatches by
  `tx_history[0] >> 1` slave address.
- Existing `esp32p4_i2c_read()`: now calls
  `responder_read()` instead of hardcoded `bmp280_read()`.
- New `esp32p4_i2c_mpu6050_self_test(s)`: minimal WHO_AM_I read
  emitting 3 i2c events + 1 i2c_rx.

### `include/hw/i2c/esp32p4_i2c.h`

- Added `esp32p4_i2c_mpu6050_self_test()` decl.

### `hw/riscv/esp32p4.c`

- New `esp32p4_i2c_mpu6050_self_test(&ms->i2c0)` call after the
  existing BMP280 self-test.

## Estado consolidado (post-2.BD)

I2C sensor matrix:

| Slave | Sensor | Phase | Validates |
|-------|--------|-------|-----------|
| 0x76, 0x77 | BMP280 | 2.AM.slave | pressure / temperature |
| 0x68, 0x69 | MPU-6050 | **2.BD** | **accel + gyro + temp** |
| (other) | "no slave" 0xFF | — | unknown-device fallback |

JSON event types: **19** (unchanged — this phase adds sensors,
not new event types).

## 38-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.AZ  | Multi-UART (UART1..UART4)                                |
| 2.BA  | TWAI (CAN bus) skeleton — TX path                        |
| 2.BB  | I2C1 + LP_UART (inventory complete)                      |
| 2.BC  | Synthetic TWAI RX responder                              |
| **2.BD** | **MPU-6050 IMU + I2C multi-sensor dispatcher**       |

## Próximas direcciones

- **SSD1306 OLED** at 0x3C: WRITE-only display, no responder
  needed; frontend renders pixel bytes from i2c events at port=0
  slave=0x3C as a 128×64 monochrome display.
- **HMC5883L magnetometer** at 0x1E: add magnetic-field
  synthetic waveform.
- **VL53L0X ToF distance** at 0x29: range readings for ultrasonic
  / distance demos.
- **MPU-6050 INT pin wiring** for motion-interrupt demos.
- **TWAI IRQ wiring** — close out the CAN chain.
- **WDT actual reset action** — close out watchdog chain.
- **Real PWM waveform on GPIO** via LEDC.
- **FreeRTOS real port** (Phase 2.V deferred).
