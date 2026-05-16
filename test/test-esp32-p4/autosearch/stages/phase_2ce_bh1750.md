# Phase 2.CE — BH1750 ambient light sensor added to I2C responder

**Estado**: ✅ done — extends the I2C synthetic-responder
dispatcher to **5 sensors**. The BH1750 differs from the
previous four (BMP280/MPU6050/HMC5883L/VL53L0X) by having
**no register space** — its 16-bit lux reading is delivered
as 2 raw bytes after a mode-command write.

Live verification (2026-05-16):

```json
{"event":"i2c_rx","port":0,"reg":208,"byte":88}    ← BMP280 chip-id 0x58
{"event":"i2c_rx","port":0,"reg":117,"byte":104}   ← MPU6050 WHO_AM_I 0x68
{"event":"i2c_rx","port":0,"reg":16, "byte":6}     ← BH1750 lux MSB
{"event":"i2c_rx","port":0,"reg":17, "byte":189}   ← BH1750 lux LSB (auto-inc)
{"event":"i2c_rx","port":1,"reg":208,"byte":88}    ← I2C1 BMP280 (unchanged)
```

BH1750 raw counts = `0x06BD = 1725` → lux ≈ `1725 / 1.2 ≈
1437 lux`. Inside the synthesized triangular 50..2000 lux
waveform.

I2C0 now exercises 3 sensors at boot; I2C1 still exercises 1
(BMP280). Zero regression on other peripherals.

## Goal

Mirror the I2C 5-sensor dispatcher pattern. BH1750 is a popular
GY-302 breakout used in many Arduino sketches for lux/light
detection. It's also a useful **boundary case** for the
dispatcher: unlike the other 4 sensors (which have register
spaces and respond to register-read commands), BH1750 has just
a 1-byte command + 2-byte data read.

This phase proves the dispatcher's `read_reg` mechanism is
flexible enough to handle register-less sensors via its
auto-increment behavior.

## Lo que SE INVESTIGÓ

### 1. BH1750 protocol shape

Arduino-side flow (claws/BH1750 library):
1. `Wire.beginTransmission(0x23)` — slave address
2. `Wire.write(0x10)` — measurement mode (continuous high-res)
3. `Wire.endTransmission()` — bus STOP
4. `delay(180)` — wait for 120-180 ms integration
5. `Wire.requestFrom(0x23, 2)` — RSTART + read 2 bytes
6. `Wire.read()` then `Wire.read()` — MSB + LSB

The 16-bit raw value is `lux × 1.2` (the chip reports counts
where 1 count = 1/1.2 lux).

### 2. Mode commands

Six measurement modes (commands `0x10` through `0x23`):

| Cmd | Mode | Resolution | Time |
|-----|------|-----------|------|
| 0x10 | continuous H-res | 1 lx | 120 ms |
| 0x11 | continuous H-res 2 | 0.5 lx | 120 ms |
| 0x13 | continuous L-res | 4 lx | 16 ms |
| 0x20 | one-time H-res | 1 lx | 120 ms |
| 0x21 | one-time H-res 2 | 0.5 lx | 120 ms |
| 0x23 | one-time L-res | 4 lx | 16 ms |

Half of these are even (0x10, 0x20), half are odd (0x11, 0x13,
0x21, 0x23). So a "MSB on even reg, LSB on odd reg" heuristic
would mis-handle the odd-numbered modes.

### 3. Distinguishing MSB vs LSB without explicit state

The I2C dispatcher's `read_reg` mechanism already exists for
burst-read auto-increment (BMP280 burst reads). On the **first**
call within a transaction, `read_reg = tx_history[1]` (the
register/mode-command from the master's write phase). On
**subsequent** calls, `read_reg++` (auto-increment).

Repurposing this: for BH1750, the **first read** has
`reg == tx_history[1]` (the mode command). Any **subsequent**
read has `reg != tx_history[1]` (auto-incremented). That
heuristic works across all 6 BH1750 modes — no parity tricks.

### 4. Two strap-selectable addresses

BH1750 supports 0x23 (ADDR low, default) and 0x5C (ADDR high).
GY-302 breakouts pull ADDR low by default. Added both to the
dispatcher switch.

### 5. Lux synthesis

Triangular 50..2000 lux over 8 seconds simulates ambient light
variation (dawn/dusk / room with people walking). Realistic
for "automatic backlight dimmer" Arduino demos.

The 8-second period was chosen to be visibly different from the
6-second VL53L0X distance period and 20-second HMC5883L
compass period — so a frontend rendering all 3 simultaneously
shows distinct cadences.

### 6. Self-test pattern

Followed the MPU6050 self-test pattern (`mpu6050_self_test`):
- Emit `fifo_tx` events for slave addr + mode command.
- Emit one READ command with byte_num=2.
- Simulate two reads via direct `esp32p4_i2c_read()` calls —
  first hits `reg == tx_history[1]` (MSB), second hits
  auto-incremented `reg+1` (LSB).
- Reset `tx_history` after to avoid polluting later
  transactions.

Result: 3 i2c events + 2 i2c_rx events emitted by the self-test
at boot.

## Lo que SÍ funcionó

1. ✅ Build clean — two files compiled
   (`hw_i2c_esp32p4_i2c.c.o`, `hw_riscv_esp32p4.c.o`).
2. ✅ Three I2C sensors fire at boot on port 0:
   - reg=0xD0 byte=0x58 (BMP280 chip ID)
   - reg=0x75 byte=0x68 (MPU6050 WHO_AM_I)
   - reg=0x10 byte=0x06 (BH1750 MSB)
   - reg=0x11 byte=0xBD (BH1750 LSB)
3. ✅ I2C1 unchanged (still BMP280 at port 1).
4. ✅ Computed lux ≈ 1437 (raw 1725 / 1.2) is within the
   synthesized 50..2000 lux envelope.
5. ✅ All other peripherals (adc/ledc/spi/rmt/rng/timg/wdt/
   uart_tx/chip_info/twai) unchanged.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Parity heuristic ruled out**: even/odd register check
   fails for odd-numbered modes (0x11, 0x13, 0x21, 0x23). The
   `reg == tx_history[1]` check works regardless of mode.

2. **State-aware function signature**: BH1750 read needs
   access to `s->tx_history[1]` to know the original mode
   command. Changed function signature from
   `bh1750_read(uint8_t reg)` to `bh1750_read(s, reg)`. Other
   sensors don't need state (their register space is fixed).

3. **Mode command 0x10 in self-test**: continuous-high-res is
   the most common Arduino default. One-time modes are less
   used.

4. **8-second lux period**: distinct from VL53L0X (6 s) and
   HMC5883L (20 s) — gives the frontend visually distinct
   cadences when multiple sensors are wired.

5. **Self-test on I2C0 only**: I2C1 stays with just BMP280 to
   keep the existing JSON event count predictable for
   regression testing. Future phase could add a
   `bh1750_self_test(&ms->i2c1)` call if I2C1 needs the
   diversity.

6. **Lux value formula**: `raw = (lux × 12) / 10` keeps the
   math integer (no float). Equivalent to `raw = lux × 1.2`
   for the lux values in our range.

## Lessons learned

1. **The dispatcher's `read_reg` mechanism is flexible** —
   originally designed for register-space sensors with burst-
   read auto-increment, it transparently handles register-
   less sensors via the "first-read-equals-tx_history[1]"
   pattern. No dispatcher refactor needed.

2. **State pointer in responder functions costs nothing** —
   passing `s` to `bh1750_read()` is a single extra parameter
   that opens up access to `tx_history` for register-less
   sensors. Future sensors with similar protocols (some
   one-wire emulations, simple command-then-data devices) can
   follow this template.

3. **5-sensor dispatcher pattern continues to scale** — adding
   the 5th sensor is ~30 LOC (responder function + 2 cases in
   dispatcher + 1 self-test). At ~6+ sensors, the dispatcher
   switch grows unwieldy and could refactor to a table.

## Implementación final

### `hw/i2c/esp32p4_i2c.c`

- New `esp32p4_i2c_bh1750_read(s, reg)` function. Triangular
  lux waveform, MSB/LSB selection via `reg == tx_history[1]`.
- Dispatcher switch extended with cases 0x23u + 0x5Cu →
  `esp32p4_i2c_bh1750_read()`.
- New `esp32p4_i2c_bh1750_self_test(s)` mirroring MPU6050
  pattern but doing 2 reads to exercise MSB + LSB.

### `include/hw/i2c/esp32p4_i2c.h`

- New forward-declaration `esp32p4_i2c_bh1750_self_test()`.

### `hw/riscv/esp32p4.c`

- New `esp32p4_i2c_bh1750_self_test(&ms->i2c0)` call after the
  existing MPU6050 self-test in the I2C0 init block.

## Estado consolidado (post-2.CE)

I2C synthetic-responder inventory:

| Address | Sensor | Phase | Register space | Default reg |
|---------|--------|-------|----------------|-------------|
| 0x76/77 | BMP280 (pressure/temp) | 2.AM | yes (0x88-0xF7) | 0xD0 (chip ID) |
| 0x68/69 | MPU-6050 (IMU) | 2.BD | yes (0x3B-0x75) | 0x75 (WHO_AM_I) |
| 0x1E | HMC5883L (magnetometer) | 2.BE | yes (0x03-0x0C) | 0x0A (ID 'H') |
| 0x29 | VL53L0X (ToF) | 2.BE | yes (0x14, 0xC0-C2) | 0xC0 (WHO_AM_I) |
| **0x23/5C** | **BH1750 (light)** | **2.CE** | **no — mode command** | **0x10 mode** |

JSON event types: **29** (no new type — same i2c/i2c_rx events,
different values per sensor).

## 67-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BD  | MPU-6050 IMU                                            |
| 2.BE  | HMC5883L magnetometer + VL53L0X ToF                     |
| 2.CD  | Per-instance SPI responder dispatch                     |
| **2.CE** | **BH1750 ambient light sensor (5th I2C responder)** |

## Próximas direcciones

- **SHT31** humidity+temperature sensor (slave 0x44/0x45).
- **CCS811** air-quality sensor (slave 0x5A/0x5B).
- **SSD1306** OLED display I2C controller (slave 0x3C/0x3D)
  — write-only commands, no read-back, would extend the
  dispatcher to handle write-only devices.
- **W5500 Ethernet** SPI responder (Phase 2.CD pattern).
- **MFRC522 RFID** SPI responder.
- **KEY_PURPOSE** eFuse field for crypto routing.
- **UART IRQ** (QOM class-override).
- **Real PWM** waveform on GPIO via LEDC.
- **FreeRTOS** scheduler.
- **CLIC cause budget exhausted** at cause 31.
- **Refactor I2C dispatcher to address-keyed table** at 6+
  sensors.
