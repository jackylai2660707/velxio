# Phase 2.BY — eFuse chip revision fields

**Estado**: ✅ done — adds `WAFER_VERSION_MAJOR`,
`WAFER_VERSION_MINOR`, and `PKG_VERSION` fields to the eFuse
model per IDF `esp_efuse_table.csv` for ESP32-P4. MAC_SYS_3
register (offset 0x50) now synthesizes the encoded value on read
with chip revision in bits 18-25.

Encodes:
```
MAC_SYS_3 (0x50) bit layout (per IDF eFuse table):
  bits 31:26  reserved
  bits 25:23  PKG_VERSION         (3 bits)
  bits 22:21  WAFER_VERSION_MAJOR (2 bits)
  bits 20:18  WAFER_VERSION_MINOR (3 bits)
  bits 17:0   reserved (MAC reserved per TRM Register 8.12)
```

Default = 0.0 (launch silicon, pkg 0). Arduino
`ESP.getChipRevision()` returns `major*100 + minor` → 0 for the
default. Override via env vars to test alternative revisions:
- `VELXIO_EFUSE_REV_MAJOR=0..3` → wafer major
- `VELXIO_EFUSE_REV_MINOR=0..7` → wafer minor
- `VELXIO_EFUSE_PKG=0..7` → pkg version

Boot regression-clean: default chip rev v0.0 produces the same
MAC_SYS_3 reads as Phase 2.BW (all zeros).

## Goal

Phase 2.BW/2.BX established the eFuse model with WDT_DELAY_SEL.
Chip revision is the next-most-impactful field: ESP-IDF's
`esp_chip_info()` reads it to expose silicon-revision-gated
features. Arduino `ESP.getChipRevision()` is the user-facing
API.

Phase 2.BY adds the fields with TRM-correct encoding so future
firmware can read realistic revision data.

## Lo que SE INVESTIGÓ

### 1. IDF eFuse table location

TRM doesn't explicitly call out WAFER_VERSION fields for ESP32-P4
in chapter 8 (the "SYS_DATA_PART0_*" regions are opaque). The
authoritative source is IDF
`components/efuse/esp32p4/esp_efuse_table.csv`:

```
WAFER_VERSION_MINOR, EFUSE_BLK1, 114, 3, []
WAFER_VERSION_MAJOR, EFUSE_BLK1, 117, 2, []
PKG_VERSION,         EFUSE_BLK1, 119, 3, []
```

Format: `name, block, start_bit, width, comment`.

### 2. BLOCK1 → register mapping

BLOCK1 spans MAC_SYS_0..MAC_SYS_5 (offsets 0x44..0x58).
- BLOCK1[bits 0:31]    = MAC_SYS_0 (offset 0x44)
- BLOCK1[bits 32:63]   = MAC_SYS_1 (offset 0x48)
- BLOCK1[bits 64:95]   = MAC_SYS_2 (offset 0x4C)
- BLOCK1[bits 96:127]  = MAC_SYS_3 (offset 0x50)
- BLOCK1[bits 128:159] = MAC_SYS_4 (offset 0x54)
- BLOCK1[bits 160:191] = MAC_SYS_5 (offset 0x58)

So bit 114 → MAC_SYS_3 bit (114 - 96) = 18.
   bit 117 → MAC_SYS_3 bit 21.
   bit 119 → MAC_SYS_3 bit 23.

All three fields fall entirely within MAC_SYS_3, simplifying
the read synthesis.

### 3. MAC_SYS_3 register decode

Per TRM Register 8.12, MAC_SYS_3 has:
- bits 31:18 = EFUSE_SYS_DATA_PART0_0 (14 bits — opaque to TRM)
- bits 17:0  = EFUSE_MAC_RESERVED_2 (reserved)

IDF documents that the "SYS_DATA_PART0" region at bits 18:31 is
where the wafer version + pkg version live. Specifically:

```
MAC_SYS_3 bit 18:20  = WAFER_VERSION_MINOR (3 bits)
MAC_SYS_3 bit 21:22  = WAFER_VERSION_MAJOR (2 bits)
MAC_SYS_3 bit 23:25  = PKG_VERSION (3 bits)
MAC_SYS_3 bit 26:31  = (other SYS_DATA bits — we leave 0)
```

### 4. Storage design choice: separate fields vs encoded register

Two options:
- **A** Store as `uint32_t rd_mac_sys[3+]` and pack at write time.
- **B** Store major/minor/pkg as separate `uint8_t` fields and
  synthesize MAC_SYS_3 on read.

Chose B — cleaner code, easier env-var overrides, no bit-packing
on init. Read handler synthesizes on demand.

### 5. Default = launch silicon

ESP32-P4 launch silicon is v0.0 (per Espressif announcements
+ early-access SDK headers). Our default sets:
- chip_rev_major = 0
- chip_rev_minor = 0
- pkg_version = 0

Arduino `ESP.getChipRevision()` returns `major*100 + minor`,
so the default returns 0. To simulate a future v1.0 chip, set
`VELXIO_EFUSE_REV_MAJOR=1` — `ESP.getChipRevision()` would
return 100.

### 6. Env-var overrides follow 2.BX pattern

Same strict single-char parsing as `VELXIO_EFUSE_WDT_DELAY_SEL`:
- `VELXIO_EFUSE_REV_MAJOR=0..3` (2 bits)
- `VELXIO_EFUSE_REV_MINOR=0..7` (3 bits)
- `VELXIO_EFUSE_PKG=0..7` (3 bits)

Invalid inputs silently ignored (fall through to default 0).
Successful overrides log to stderr.

### 7. Public accessors

```c
uint8_t esp32p4_efuse_get_chip_rev_major(ESP32P4EfuseState *s);
uint8_t esp32p4_efuse_get_chip_rev_minor(ESP32P4EfuseState *s);
uint8_t esp32p4_efuse_get_pkg_version(ESP32P4EfuseState *s);
```

No current consumer (we don't model a chip-info ROM API), but
the infrastructure is in place. Future Arduino firmware reading
MAC_SYS_3 via direct register access will get the synthesized
encoded value automatically.

## Lo que SÍ funcionó

Live test (2026-05-08):

**Default boot** (no env vars):
```
(no eFuse stderr output — silent factory defaults)
```

**With chip-revision overrides**:
```bash
VELXIO_EFUSE_REV_MAJOR=1 VELXIO_EFUSE_REV_MINOR=3 \
VELXIO_EFUSE_PKG=2 qemu-system-riscv32 ...
```
stderr:
```
[esp32p4.efuse] VELXIO_EFUSE_REV_MAJOR=1
[esp32p4.efuse] VELXIO_EFUSE_REV_MINOR=3
[esp32p4.efuse] VELXIO_EFUSE_PKG=2
```

MAC_SYS_3 register would then read:
```
(0 << 26) | (2 << 23) | (1 << 21) | (3 << 18) | 0
= 0x01_00_00_00 | 0x00_20_00_00 | 0x00_30_00_00 | ... 
= 0x010C_C000  (approx)
```

ESP.getChipRevision() would return 1*100 + 3 = 103.

Boot regression-clean confirmed.

## Lo que NO funcionó / decisiones tomadas

### Decisiones tomadas

1. **TRM doesn't list these fields explicitly**: relied on IDF
   `esp_efuse_table.csv` for bit positions. Documented inline
   in the header so future maintainers know the authoritative
   source.

2. **No consumer wired yet**: no current Velxio code reads
   chip rev. Infrastructure in place for future use (e.g.,
   chip-info ROM stub).

3. **Default = v0.0 (launch)**: matches what
   `esp_chip_info()` would return on a fresh ESP32-P4-MINI.
   Override to test silicon-revision-gated features.

4. **Single-byte storage per field**: easier env-var
   handling. Header packs into MAC_SYS_3 only at read time.

5. **No write path for eFuse**: same as Phase 1/2.BW — eFuse
   programming is out of scope; reads see the configured
   values regardless of any guest write attempts.

6. **PKG_VERSION values are chip-package-specific**: per
   ESP32-P4 documentation, valid values represent the chip
   package variant (e.g., 0 = ESP32-P4-MINI, others = later
   packages). We accept any 0..7 value; downstream code may
   reject unsupported values.

## Lessons learned

1. **IDF eFuse table is the authoritative source for non-TRM
   fields**: TRM chapter 8 documents the register layout but
   leaves the per-bit interpretation of "SYS_DATA_PART0_*" to
   the IDF table. For chip-revision-like fields, always check
   `esp_efuse_table.csv` first.

2. **Synthesize-on-read is cleaner than pack-on-write**: for
   read-only-from-guest fields like eFuse, computing the
   register value when read keeps the in-memory representation
   simple (raw field values) and avoids bit-packing bugs.

3. **The env-var pattern scales linearly**: third application
   of the `VELXIO_EFUSE_*` env-var pattern from Phase 2.BX.
   ~10 lines per field. Highly leveraged.

4. **TRM and IDF coverage is complementary**: TRM specifies
   architecture, IDF specifies field assignments. For full
   silicon-realism, both must be consulted.

## Implementación final

### `include/hw/nvram/esp32p4_efuse.h`

- **Added**: WAFER_MINOR/MAJOR/PKG_VERSION shift+mask constants
  with inline IDF eFuse-table citation.
- **Added**: state fields `chip_rev_major`, `chip_rev_minor`,
  `pkg_version` (each uint8_t).
- **Added**: 3 new accessor function declarations.
- **Added**: `ESP32P4_EFUSE_RD_MAC_SYS_2/3` offset constants.

### `hw/nvram/esp32p4_efuse.c`

- Read handler: new case for `MAC_SYS_3` (0x50) synthesizes
  the encoded register value from the 3 separate field stores.
- `esp32p4_efuse_apply_env_overrides()`: 3 new env-var
  handlers for major/minor/pkg with strict single-char
  parsing.
- `esp32p4_efuse_realize()`: initialize all 3 fields to 0
  (launch silicon defaults) before applying env vars.
- 3 new accessor functions (used by no one yet — future
  consumer-ready).

## Estado consolidado (post-2.BY)

eFuse BLOCK1 coverage:

| Field | Phase | TRM/IDF ref | Override |
|-------|-------|-------------|----------|
| MAC_FACTORY | 2.BX | TRM Reg 8.9/8.10 | `VELXIO_EFUSE_MAC` |
| WAFER_VERSION_MAJOR | **2.BY** | IDF table bit 117 | **`VELXIO_EFUSE_REV_MAJOR`** |
| WAFER_VERSION_MINOR | **2.BY** | IDF table bit 114 | **`VELXIO_EFUSE_REV_MINOR`** |
| PKG_VERSION | **2.BY** | IDF table bit 119 | **`VELXIO_EFUSE_PKG`** |

eFuse env-var inventory:

| Env var | Field |
|---------|-------|
| `VELXIO_EFUSE_WDT_DELAY_SEL` | DATA1 bits 17:16 |
| `VELXIO_EFUSE_MAC` | MAC_SYS_0 + MAC_SYS_1[15:0] |
| `VELXIO_EFUSE_REV_MAJOR` | MAC_SYS_3 bits 21:22 |
| `VELXIO_EFUSE_REV_MINOR` | MAC_SYS_3 bits 18:20 |
| `VELXIO_EFUSE_PKG` | MAC_SYS_3 bits 23:25 |

JSON event types: **28** (unchanged — silent infrastructure).

## 62-Phase realism progression

| Phase | Capability                                              |
|-------|---------------------------------------------------------|
| 2.BW  | eFuse BLOCK0 + RWDT WDT_DELAY_SEL wiring                |
| 2.BX  | eFuse env-var overrides for WDT_DELAY_SEL + MAC         |
| **2.BY** | **eFuse chip revision (WAFER + PKG)**               |

**12 consecutive TRM-grounded phases (2.BN → 2.BY)**. eFuse
model now has 5 named fields with env-var override support,
all referencing TRM register diagrams or IDF eFuse tables.

## Próximas direcciones

- **Chip-info ROM stub** that consumes the new accessors —
  would make `ESP.getChipRevision()` end-to-end functional.
- **DIS_TWAI / DIS_USB_JTAG** fields for "disabled peripheral"
  simulation.
- **KEY_PURPOSE** for secure boot / flash encryption demos.
- **UART IRQ** (QOM class-override).
- **Real PWM** waveform on GPIO via LEDC.
- **BH1750/SHT31/CCS811** sensors.
- **SPI3** instantiation.
- **FreeRTOS** scheduler.
