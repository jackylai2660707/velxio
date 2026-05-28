# Phase 2.CX — BME280 humidity+temp+pressure sensor + dispatcher refactor (bool → function-pointer)

**Estado**: ✅ done — adds Bosch BME280 as the 10th I2C sensor
and refactors the Phase 2.CW per-address override mechanism from
a sensor-specific bool flag to a generic function-pointer slot.
The result: three sensors (BMP280 default, MS5611 via env-var,
BME280 via env-var) all coexist at the shared 0x76/0x77 address
space, **independently selectable per address**.

Live verification of 3-way coexistence (MS5611 at 0x76 + BME280
at 0x77 in one boot):

```
[esp32p4.i2c0] addr 0x76 = ms5611 (VELXIO_I2C_SENSOR_AT_76 override)
[esp32p4.i2c0] addr 0x77 = bme280 (VELXIO_I2C_SENSOR_AT_77 override)

MS5611 PROM @ 0x76:
  reg=162 (0xA2), byte=156 (0x9C)  ← C1 SENS_T1 MSB
  reg=163 (0xA3), byte=191 (0xBF)  ← C1 SENS_T1 LSB → 0x9CBF = 40127 ✓
BME280 burst @ 0x77:
  reg=208 (0xD0), byte=96 (0x60)   ← BME280 chip ID ✓ (BMP280 would be 0x58)
  reg=247..254, bytes 0x65/0xA6/0/0x82/0xA1/0xC0/0x6D/0xC2
    ← press_raw 0x65A600, temp_raw 0x82A1C0, hum_raw 0x6DC2

Default boot (no env vars): BMP280 chip ID 0x58 at 0xD0 ✓
  (Phase 2.AM..2.CW regression-clean)
```

## Goal

Two things in one phase:

**1. BME280 sensor model.** The Bosch BME280 is BMP280's
humidity-aware sibling — same package, same address space,
register-mapped (unlike MS5611). Distinguished from BMP280 only
by the chip ID at register 0xD0 (0x60 vs 0x58). Adds a 10th I2C
responder.

**2. Dispatcher refactor — bool → function-pointer.** Phase
2.CW introduced `addr76_is_ms5611` / `addr77_is_ms5611` bools.
That design didn't scale past one alternative sensor: adding
BME280 would need `addr76_is_bme280` + `addr77_is_bme280`, and
the dispatcher would grow an if-chain per alternative. Replaced
with `addr76_override` / `addr77_override` function pointers —
NULL falls back to BMP280, non-NULL calls the override directly.

Future shared-address sensors (BMP180 at 0x77, BME680 also at
0x76/0x77, etc.) cost one new env-var-value mapping + one new
responder — zero dispatcher edits.

## Lo que SE INVESTIGÓ

### 1. Bosch BME280 datasheet — register map and chip ID

Per § 5.3 "Memory Map":

| Offset      | Purpose                                              |
|-------------|------------------------------------------------------|
| 0x88..0x9F  | Calibration block 1 (dig_T1..T3, dig_P1..P9, 24 B)   |
| 0xA1        | dig_H1 (humidity cal, unsigned 8-bit)                |
| 0xD0        | id — fixed 0x60 (= BME280; BMP280 returns 0x58)      |
| 0xE0        | reset (write 0xB6 to reset)                          |
| 0xE1..0xE7  | Calibration block 2 (dig_H2..H6, 7 B)                |
| 0xF2        | ctrl_hum (humidity oversampling)                     |
| 0xF3        | status (bit 3 = measuring, bit 0 = im_update)        |
| 0xF4        | ctrl_meas (temp+press oversampling + mode)           |
| 0xF5        | config (standby + IIR filter + spi3w_en)             |
| 0xF7..0xF9  | press_raw (20-bit, MSB / LSB / XLSB[7:4])            |
| 0xFA..0xFC  | temp_raw  (20-bit, MSB / LSB / XLSB[7:4])            |
| 0xFD..0xFE  | hum_raw   (16-bit, MSB / LSB)                        |

The **only byte that distinguishes BME280 from BMP280** at the
driver level is 0xD0 (0x60 vs 0x58). Adafruit_BME280::begin()
reads it once and bails on mismatch.

### 2. Reference calibration set — Bosch § 8.1

Bosch's datasheet § 8.1 publishes a worked example with a
canonical reference cal set + reference raw values:

```
dig_T1 = 27504    dig_P1 = 36477    dig_H1 = 75
dig_T2 = 26435    dig_P2 = -10685   dig_H2 = 351
dig_T3 = -1000    dig_P3 = 3024     dig_H3 = 0
                  dig_P4 = 2855     dig_H4 = 332
                  dig_P5 = 140      dig_H5 = 0
                  dig_P6 = -7       dig_H6 = 30
                  dig_P7 = 15500
                  dig_P8 = -14600
                  dig_P9 = 6000

adc_T = 0x82A1C  → 25.08 °C
adc_P = 0x65A60  → 1013.21 hPa
adc_H = 0x6DC2   → ~50 %RH
```

Using these published values means **any** Bosch BME280 driver
will decode our synthetic raw bytes to sensible physical
quantities — no driver-specific tuning required. This is the
sensor equivalent of "use the standard test vector": any
implementation that gets the numbers wrong has a bug in the
implementation, not in the test data.

### 3. dig_H4 / dig_H5 packed layout (§ 5.4.6)

The most-fiddly part of the BME280 register layout: dig_H4
(signed 12-bit) and dig_H5 (signed 12-bit) are **packed across
3 bytes** at 0xE4..0xE6:

```
0xE4 = dig_H4[11:4]
0xE5 = (dig_H5[3:0] << 4) | (dig_H4[3:0] & 0x0F)
0xE6 = dig_H5[11:4]
```

With H4 = 332 = 0x14C and H5 = 0:
- 0xE4 = 0x14
- 0xE5 = (0x0 << 4) | (0xC & 0x0F) = 0x0C
- 0xE6 = 0x00

Got this right on the first attempt only because I sketched the
bit-layout on paper before writing the C. Driver code that
implements the **inverse** unpacking (e.g., Adafruit_BME280
`readCoefficients()`) verifies the encoded values during init;
mis-packed cal bytes cause humidity to read as garbage.

### 4. Refactor design — bool flags vs function pointers

Phase 2.CW added `addr76_is_ms5611` / `addr77_is_ms5611` to
`ESP32P4I2cState`, with the dispatcher checking each bool
before falling through to the linear table scan. For one
alternative sensor (MS5611), this was clean.

Adding BME280 would require:

**Option A — additional bools**: `addr76_is_bme280`,
`addr77_is_bme280`, and a 4-way dispatcher gate
(`is_ms5611 ? ms5611_read : is_bme280 ? bme280_read : table_scan`).
The dispatcher would grow N branches per new shared-address sensor.

**Option B — function pointer (chosen)**: replace the bools
with `uint8_t (*addr76_override)(ESP32P4I2cState *, uint8_t)` /
`addr77_override`. The dispatcher checks for non-NULL and calls
through directly. Adding BME280 is one new env-var-value mapping
in the machine init's lookup table; the dispatcher itself is
untouched.

Function pointers also clean up the CONVERT-latch logic in the
FIFO_DATA write path: instead of `s->addr76_is_ms5611`, we
write `s->addr76_override == esp32p4_i2c_ms5611_read` — same
intent, decoupled from the per-sensor bool field. (Future
write-state-tracking sensors at shared addresses will follow
the same pattern.)

### 5. Self-test orchestration with N alternatives

With N possible sensors at 0x76 and N at 0x77, the machine init
needs to fire **all** matched self-tests. The chosen pattern:

```c
struct { const char *name; uint8_t (*fn)(...); } sensors[] = {
    { "ms5611", esp32p4_i2c_ms5611_read },
    { "bme280", esp32p4_i2c_bme280_read },
};
/* loop: match env-var value to sensors[i].name, install fn */
/* then: for each sensor, fire self-test if it's installed at
 * either address */
```

Adding the 3rd alternative (e.g., BME680 in a future phase)
is one row in `sensors[]` + one `if(...) fire_selftest()` block.
The lookup logic itself doesn't grow.

### 6. Why preserve BMP280 as default

The Phase 2.AM..2.CW regression chain includes ~12 self-tests
that exercise 0x76/0x77 → BMP280. Switching the default to
BME280 (or "no default, force the env var") would break that
regression chain. Keeping BMP280 default + new sensors
opt-in via env var preserves all prior validation.

This is the same logic as the eFuse env-var pattern (Phase 2.BX):
"defaults match the historical behavior; env vars opt into new
features".

## Lo que SÍ funcionó

1. ✅ Build clean — no new source files, modified existing 3
   (i2c.c + i2c.h + machine init).
2. ✅ BME280 chip ID returns 0x60 at 0xD0 ✓ (distinguishes from
   BMP280's 0x58).
3. ✅ 8-byte burst read at 0xF7..0xFE returns the Bosch § 8.1
   reference raw values: 0x65A600 / 0x82A1C0 / 0x6DC2.
4. ✅ Cal block 1 (24 B at 0x88..0x9F): all 12 coefficients
   match Bosch reference, LSB-first encoding correct.
5. ✅ Cal block 2 (7 B at 0xE1..0xE7): dig_H2..H6 with the
   tricky dig_H4/H5 packed-bit layout correct.
6. ✅ dig_H1 at 0xA1 returns 75 (single byte, unsigned).
7. ✅ MS5611 self-test regression-clean (function-pointer
   refactor doesn't break Phase 2.CW behavior).
8. ✅ BMP280 self-test regression-clean (default unchanged).
9. ✅ **3-way coexistence**: `VELXIO_I2C_SENSOR_AT_76=ms5611
   VELXIO_I2C_SENSOR_AT_77=bme280` boots → MS5611 PROM read at
   0x76 + BME280 burst read at 0x77 both succeed in the same
   boot, distinguishable in JSON by `port` + the reg values.
10. ✅ Status register at 0xF3 returns 0 → Adafruit_BME280
    `while (status & 0x09)` busy-wait exits immediately.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **Function pointers over `enum` + switch**: an enum would
   require updating the dispatcher every time a new sensor is
   added. The function-pointer table sets the pointer once at
   machine init and the dispatcher is sensor-agnostic.

2. **`NULL` = use the table** (i.e., BMP280 default) instead of
   a "no override" sentinel: NULL is the natural zero-init
   value, requires no constructor, and reads naturally
   (`if (override) override(s, reg)`).

3. **Keep BMP280 in the responder table, not as the override
   default**: the table already encodes the default behavior
   for 0x76/0x77. Reaching the table on NULL override is the
   simplest fall-through. Moving BMP280 to "the override that's
   set when nothing else is" would add code with no benefit.

4. **Function-pointer comparison for CONVERT-latch gating**
   (`addr76_override == esp32p4_i2c_ms5611_read`): cleaner than
   adding a parallel "what kind of sensor is this" enum. C
   guarantees function-pointer equality even across compilation
   units. Reads naturally.

5. **Bosch § 8.1 reference cal set unchanged from Phase 2.CW
   pattern**: same rationale as MS5611's datasheet § A.1
   reference values — driver-agnostic, decode-to-physically-
   sensible.

6. **Skipped CRC verification on BME280 cal block**: BME280
   doesn't publish a CRC for its cal block (unlike MS5611's C7
   CRC-4). Nothing to verify.

7. **Status register hard-coded to 0** (idle, no NVM update):
   the alternative (synthesize a "measuring" pulse) would
   need a guest-visible state machine + timing — overkill for
   the canonical "read once" demo. Real silicon completes a
   conversion in ~10 ms; our model is instantaneous.

8. **Only I2C0 wired**: same as Phase 2.CW. Multi-bus demo can
   wire I2C1 later if needed.

9. **No new JSON event type** — reuses `i2c` / `i2c_rx`. Event
   type count stays at 35. The frontend can distinguish BME280
   reads from BMP280 reads by reading the chip ID byte once,
   then routing subsequent reads through the appropriate
   decoder.

10. **No "reset" register handling**: writing 0xB6 to 0xE0 is
    a no-op in our model. Real silicon resets the cal block
    and ctrl registers; we never modify them so there's
    nothing to reset.

## Lessons learned

1. **First sign of refactor pressure: the second instance of a
   pattern.** Phase 2.CW set up bool flags for one alternative
   sensor. Adding BME280 (the second alternative) immediately
   surfaced the design's lack of scale. Refactoring then was
   cheap (3 fields renamed, ~10 lines of dispatcher logic
   simplified). Refactoring at the 5th alternative would be
   painful.

2. **Function pointers beat enums for "select 1 of N
   behaviors".** C function pointers compose cleanly, support
   forward declaration via headers, and let new behaviors plug
   in without touching the dispatcher.

3. **Manufacturer-published reference test vectors are gold.**
   Bosch's § 8.1 + TE's § A.1 give us datasheet-canonical
   numbers that **any** correct driver implementation produces.
   No driver-specific tuning, no risk of "looks right by chance".

4. **Pack-bit layouts must be sketched before coding.** Got
   dig_H4/H5 right on the first attempt only because I drew the
   bit layout on paper first. Trying to type-correct an in-line
   bitfield encoding without that step would have failed.

5. **Test 3-way coexistence as a separate scenario.** Each
   sensor self-test in isolation could pass while the
   coexistence boot fails (e.g., shared state, wrong dispatcher
   ordering). Adding the explicit `0x76=ms5611 0x77=bme280`
   test caught zero bugs but proved the architecture works for
   the case it's designed for.

## Implementación final

### `include/hw/i2c/esp32p4_i2c.h`

- Replaced `bool addr76_is_ms5611` / `addr77_is_ms5611` with
  function-pointer `addr76_override` / `addr77_override`.
- New prototype `esp32p4_i2c_bme280_self_test(s)`.
- Exported `esp32p4_i2c_bme280_read` + `esp32p4_i2c_ms5611_read`
  prototypes (machine init installs them as override pointers).

### `hw/i2c/esp32p4_i2c.c`

- Dropped `static` from `esp32p4_i2c_ms5611_read` (now exported).
- New `esp32p4_i2c_bme280_read(s, reg)` responder fn with
  Bosch § 8.1 reference cal + raw values.
- Updated dispatcher pre-scan from bool check to
  `if (s->addr76_override) return s->addr76_override(s, reg)`.
- Updated CONVERT-latch gating in FIFO_DATA write hook from
  `addr76_is_ms5611` to
  `addr76_override == esp32p4_i2c_ms5611_read`.
- Updated MS5611 self-test address picker to use the function-
  pointer equality check.
- New `esp32p4_i2c_bme280_self_test(s)` — ID check + 8-byte
  burst read.

### `hw/riscv/esp32p4.c`

- Replaced single-sensor env-var read with a `{ name, fn }`
  lookup table iterating over `{ ms5611, bme280 }`.
- Both self-tests fire when their pointer is installed at
  either address.

## Estado consolidado (post-2.CX)

I2C dispatcher inventory:

| Addr     | Sensor       | Phase | Class                       |
|----------|--------------|-------|-----------------------------|
| 0x76/77  | BMP280       | 2.AM  | env-var-default             |
| 0x68/69  | MPU6050      | 2.BD  | always-on                   |
| 0x1E     | HMC5883L     | 2.BE  | always-on                   |
| 0x29     | VL53L0X      | 2.BE  | always-on                   |
| 0x23/5C  | BH1750       | 2.CE  | always-on                   |
| 0x44/45  | SHT31        | 2.CF  | always-on                   |
| 0x5A/5B  | CCS811       | 2.CG  | always-on                   |
| 0x3C     | SSD1306      | 2.CH  | always-on (write-only)      |
| 0x39     | APDS-9960    | 2.CJ  | always-on                   |
| 0x76/77  | MS5611       | 2.CW  | env-var override (fn-ptr)   |
| **0x76/77** | **BME280**| **2.CX** | **env-var override (fn-ptr)** |

10 distinct sensors; 3-way shared-address slot at 0x76/0x77
with independent per-address selection.

JSON event types: **35** (unchanged).

## 86-Phase realism progression

| Phase | Capability                                                |
|-------|-----------------------------------------------------------|
| 2.CV  | Multi-block HMAC — closes Phase 2.CN limitation           |
| 2.CW  | MS5611 + env-var dispatcher override (bool flags)         |
| **2.CX** | **BME280 + dispatcher refactor to function pointers**  |

Three sensors now coexist at the shared 0x76/0x77 slot,
independently selectable per address. Real-world Arduino
sketches using any of BMP280 / MS5611 / BME280 at the standard
addresses see the right responder when the user picks via env
var — closest possible model of how real boards are wired.

## Próximas direcciones

- **BMP180** (0x77 only) — older Bosch part with completely
  different protocol. Slot into the same env-var dispatcher;
  one more row in the `sensors[]` table.
- **BME680** (0x76/0x77, adds VOC sensor on top of BME280) —
  another fn-pointer slot.
- **MPL3115A2** (0x60) — no collision, just a new always-on
  table row.
- **Lis3dh / ADXL345 accelerometers** — common collision pairs
  at 0x18/0x19 and 0x53.
- **SHA-384/512/512-t modes** — 64-bit working state + 128-bit
  length field.
- **HMAC streaming refactor** — remove 1024-byte cap.
- **Secure Boot digest verifier** — TRM Chapter 29.
- **AES-CBC / AES-GCM / XTS-AES** block modes (needs DMA).
- **Digital Signature peripheral** — KEY_PURPOSE=7.
- **RSA / ECDSA / ECC** crypto peripherals.
- **USB Serial/JTAG IRQ wiring** — needs free CLIC cause.
- **W5500 / MFRC522** SPI responders.
- **UART IRQ** via interrupt matrix.
- **Real PWM** waveform via LEDC.
- **JTAG bridge peripheral**.
- **FreeRTOS** scheduler resurrection.
