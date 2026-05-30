# Phase 2.DQ — I2S0 TX audio via AHB-DMA

**Estado:** ✅ DONE — new I2S0 audio controller at `0x500C6000`; TX playback
fed by the AHB-DMA, verified by streaming a PCM ramp through the out-link
and checking the captured stream byte-exact. **Variety pivot** after a
10-phase crypto/DMA arc, and the **first non-crypto AHB-DMA peri-attach** —
the DMA infrastructure is now demonstrated as a general facility.

Files:
- `third-party/qemu-lcgamboa/hw/misc/esp32p4_i2s.c` (new, ~270 lines)
- `third-party/qemu-lcgamboa/include/hw/misc/esp32p4_i2s.h` (new)
- `third-party/qemu-lcgamboa/hw/misc/meson.build` (+1 line)
- `third-party/qemu-lcgamboa/hw/riscv/esp32p4.c` (include + struct field +
  init block at 0x500C6000 + self-test)
- `test/test-esp32-p4/autosearch/scripts/run_i2s_selftest.sh`

---

## SE INVESTIGÓ (what was researched)

After RSA→DS→ECDSA→ECC→AHB/AXI-DMA→DMA-SHA/AES/GCM (Phases 2.DG–2.DP), the
crypto + DMA subsystems are exhaustively covered. A deliberate variety
pivot to a **user-facing** peripheral that also **proves the DMA work is
general**: I2S audio is the canonical streaming-DMA consumer, and the
peripheral Arduino `I2S` / ESP-IDF `i2s_std` sketches use for DAC/amp
playback and MEMS-mic capture.

Facts established (IDF `i2s_reg.h` / `i2s_ll.h` / `gdma_channel.h`):
- I2S0 base = `DR_REG_HPPERIPH1_BASE (0x500C0000) + 0x6000 = 0x500C6000`;
  3 I2S instances.
- **I2S0 rides the AHB-DMA** (not AXI like crypto): `GDMA_TRIG_PERIPH_I2S0
  = 3`, bus = AHB. (I2S1=4, I2S2=5.)
- `TX_CONF` @ 0x24: `TX_RESET`[0], **`TX_START`[2]** (`i2s_ll_tx_start`
  sets `tx_conf.tx_start = 1`), `TX_SLAVE_MOD`[3].
- `TX_CONF1` @ 0x28: `TX_BITS_MOD`[18:14] = bits/sample − 1 (default 15 →
  16-bit).

---

## SÍ funcionó (what worked)

- **AHB-DMA peri-attach via the established pattern.** The same decoupled
  drain used for DMA-SHA/AES on the AXI-DMA applied verbatim to the
  AHB-DMA: read the bound channel's `OUT_PERI_SEL`/`OUT_LINK_ADDR` through
  the address space (no struct coupling), walk the descriptor chain,
  return ownership→CPU. Only the base (0x50085000) + the AHB OUT register
  offsets differ — pulled straight from `esp32p4_dma.h`.
- **Sample capture as the audio tap.** On `TX_START` the model drains the
  out-link into `s->capture[]`, decodes the sample width from `TX_BITS_MOD`,
  and emits an `i2s` JSON event (`samples`, `bits`, `first[]`) — the stream
  a frontend can hand to Web Audio. The 43rd event type.
- **Byte-exact verification in running QEMU:**
  ```
  op#1 TX 64 samples (16-bit) first=[-8192,-7935]
  self-test TX-via-AHB-DMA=OK (128 bytes)
  ```
  A 64-sample 16-bit ramp (`i·257 − 8192`) fed through the AHB-DMA
  out-link came back byte-identical in the capture. AHB-DMA + AES-DMA
  regressions stayed green.
- **Clean, bounded peripheral.** Register block absorbs all config; only
  `TX_START` has a side effect. ~270 lines, no new infrastructure.

---

## NO funcionó / decisiones (what failed + decisions made)

- **Variety candidates triaged first.** Before I2S I scoped TSENS and PCNT
  and rejected them for *this* phase:
  - **TSENS** (on-chip temp): the raw→°C conversion (`0.4386·regval −
    27.88·offset − 20.52`) is simple, but the per-range `offset` is set via
    **REGI2C** (the analog config bus) and the attribute table + absolute
    base weren't cleanly locatable — more coupling than a bounded phase
    wants. Deferred.
  - **PCNT** (pulse counter): needs **GPIO-matrix → PCNT signal routing** to
    feed pulses, which isn't modeled — verification would need a synthetic
    injection hook. Deferred.
  - **I2S** won: self-contained (DMA-fed, no extra coupling), user-facing,
    and showcases the AHB-DMA.
- **Scope: TX one-shot, no real-time pacing.** Real I2S streams continuously
  at the sample rate, pulling from the DMA as the FIFO drains. The model
  does a **one-shot capture** on `TX_START` (drains the currently-linked
  descriptors). The captured samples are correct; the *timing* is not
  modeled. Documented. Good enough for "play this buffer" sketches and the
  audio tap; continuous/looped DSED streaming + sample-rate pacing is a
  follow-up.
- **No CPU interrupt.** The CLIC budget is exhausted (cause 47 = AXI-DMA),
  so I2S TX-done raises no CPU line; guests that poll work, ISR-driven
  streaming would need the INTMTX (flagged as the top structural gap).
- **RX + I2S1/2 + PDM not modeled.** The `peri_sel_id` field is
  instance-parameterized so I2S1/2 (4/5) drop in trivially when needed.

---

## Lessons learned

1. **A well-established pattern makes a new peripheral cheap.** The
   peri-attach DMA drain (4th use now) meant I2S's "interesting" part was
   ~30 lines; the rest is a register block. Investing in the pattern across
   SHA/AES paid off again.
2. **Triage variety candidates by their hidden coupling, not their headline
   value.** TSENS/PCNT looked simpler than I2S but had REGI2C / GPIO-matrix
   coupling that would balloon the phase; I2S's DMA-fed design was actually
   the most self-contained.
3. **Capture-and-compare is a clean oracle for a streaming peripheral.**
   "Samples in == samples captured" needs no external reference and proves
   the whole DMA→peripheral path end to end.

## Implementación final (key shape)

- `esp32p4_i2s_tx_drain(s)`: find the AHB-DMA OUT channel with
  `PERI_SEL == peri_sel_id`, read `OUT_LINK_ADDR`, walk descriptors into
  `s->capture[]`, owner→CPU writeback.
- `esp32p4_i2s_tx_start(s)`: drain, decode `TX_BITS_MOD`, tally samples,
  emit the `i2s` event. Hooked on `TX_CONF.TX_START`.
- `peri_sel_id` field defaults to 3 (I2S0); parameterizes I2S1/2.

## Estado consolidado (DMA consumers)

| Consumer | Bus | Attach | Status |
|----------|-----|--------|--------|
| SHA / AES / GCM | AXI-DMA | peri 5 / 4 | ✅ (2.DM–2.DP) |
| **I2S0 TX** | **AHB-DMA** | **peri 3** | **✅ (2.DQ)** |
| SPI / UHCI / I2S1-2 RX | AHB/AXI | various | not modeled |

## Próximas direcciones (next)

- I2S RX (mic capture), I2S1/2, PDM, real-time sample-rate pacing.
- **INTMTX** (interrupt matrix) — the top structural gap (also unblocks
  ISR-driven I2S streaming).
- TSENS (needs REGI2C offset modeling), PCNT (needs GPIO-matrix routing),
  MCPWM (servos/motors).
