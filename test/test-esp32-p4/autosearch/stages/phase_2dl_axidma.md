# Phase 2.DL — AXI-DMA (GDMA, AXI bus) controller + interrupt-matrix finding

**Estado:** ✅ DONE — real peripheral at `0x5008A000` (the crypto-DMA bus),
3 RX/TX channel pairs, distinct register layout from AHB-DMA, mem2mem
verified in running QEMU (single / gather 2→1 / scatter 1→2). Surfaced
and documented a significant interrupt-architecture finding (see below).

Files:
- `third-party/qemu-lcgamboa/hw/misc/esp32p4_axi_dma.c` (new, ~430 lines)
- `third-party/qemu-lcgamboa/include/hw/misc/esp32p4_axi_dma.h` (new)
- `third-party/qemu-lcgamboa/hw/misc/meson.build` (+1 line)
- `third-party/qemu-lcgamboa/hw/riscv/esp32p4.c` (include + struct field +
  init block at 0x5008A000 + 1 combined IRQ at cause 47 + self-test)
- `test/test-esp32-p4/autosearch/scripts/run_axidma_selftest.sh`

---

## SE INVESTIGÓ (what was researched)

The AXI-DMA is the **high-bandwidth GDMA the ESP32-P4 crypto blocks use**:
`gdma_channel.h` pins AES0 (peri_sel 4) and SHA0 (peri_sel 5) to the AXI
bus. So modeling it is the prerequisite for DMA-mode AES/SHA (the real
mbedtls hardware path for bulk crypto).

Tracks:
1. **Direct IDF reads**: `soc/axi_dma_reg.h`, `axi_dma_struct.h`,
   `hal/axi_dma_ll.h`, `gdma_channel.h`, `soc/interrupts.h`.
2. **`axi-dma-research` Workflow** (3 readers → synthesis) — completed
   cleanly, confirmed the distinct register layout and flagged the IRQ
   budget constraint.

### AXI-DMA register map (base 0x5008A000) — DIFFERENT from AHB-DMA
- **3 channel pairs**, per-channel stride **0x68** (AHB was 0xC0).
- The 4 INT regs are **inlined at each channel's head** (not a separate
  global INT array like AHB): IN block @ `ch*0x68`, OUT block @
  `0x138 + ch*0x68`; within a block RAW/ST/ENA/CLR @ +0x00/04/08/0C.
- IN_CONF0 @ +0x10 (**MEM_TRANS_EN = bit2**, AHB had bit4); IN_RST = bit0.
- LINK is **split**: LINK1 @ +0x20 (control) + LINK2 @ +0x24 (full 32-bit
  descriptor base address), both inline per channel. (AHB kept the addr in
  a separate trailing array at 0x3AC/0x3B8; AXI keeps it inline at +0x24.)
- IN_LINK1: AUTO_RET[0] STOP[1] **START[2]** RESTART[3]; OUT_LINK1: STOP[0]
  **START[1]** RESTART[2] (shifted, no auto_ret — same asymmetry as AHB).
- IN_SUC_EOF_DES_ADDR @ +0x2C; IN_PERI_SEL @ +0x44.
- INT bits: IN_DONE[0] **IN_SUC_EOF[1]** IN_ERR_EOF[2] IN_DSCR_ERR[3]…;
  OUT_DONE[0] OUT_EOF[1] OUT_DSCR_ERR[2] OUT_TOTAL_EOF[3]…
- DATE @ 0x2D8 default 36712768.
- Descriptor format: **identical** `dma_descriptor_t` (size 12-bit, max
  4095/desc) — AXI differs only in alignment, not field layout.

---

## SÍ funcionó (what worked)

- **Descriptor-walk reuse.** Because the descriptor format is identical to
  AHB-DMA, the proven `run_m2m` gather/scatter walk carried over verbatim
  (only the register offsets + state struct differ). First build, all
  three self-tests green:
  ```
  self-test A single-desc copy=OK writeback=OK
  self-test B gather 2->1=OK
  self-test C scatter 1->2=OK writeback=OK
  ```
- **Independent reads + workflow confirmation** again made the workflow a
  verification pass — every AXI offset I'd derived (0x68 stride, inlined
  INT, LINK1/LINK2, MEM_TRANS_EN bit2) was confirmed.
- 3 `axi_dma` JSON events; AHB-DMA + ECC + ECDSA regressions still green.

---

## NO funcionó / decisiones (what failed + decisions made)

### The big one — interrupt-matrix architecture (investigated, corrected)

Going in, I planned an "interrupt fidelity pass": remap the crypto + DMA
peripherals to their **real ETS_*_INTR_SOURCE numbers** (AHB-DMA 56-61,
AXI-DMA 62-67, RSA 68, AES 69, SHA 70, ECC 71, ECDSA 72) and bump the CLIC
budget to the real 128-source space.

**This was a category error, caught by reading `esp_cpu.h` carefully:**
- `ETS_*_INTR_SOURCE` (0..127, ETS_MAX=128) are **interrupt-MATRIX source
  IDs** — the peripheral side.
- The ESP32-P4 CPU CLIC exposes only **32 external interrupt lines**
  (IDF `RV_EXTERNAL_INT_COUNT=32` + `RV_EXTERNAL_INT_OFFSET=16` → CPU
  causes **16..47**).
- The **INTMTX** muxes any of the 128 matrix sources onto any of the 32
  CPU lines (IDF `esp_intr_alloc` programs it at runtime).

So the 128 ETS numbers are **not** CPU cause numbers, and you cannot use
62-72 as CPU causes (max CPU cause is 47). The model's flat 1:1
peripheral→cause wiring (16..47) is actually a reasonable *abstraction* of
the INTMTX's dynamic allocation — but it has run out of CPU lines: the
current map fills 17..46 and **cause 47 is the only one free**.

**Decisions:**
1. **Abandoned the ETS-number remap** (documented here so it isn't retried).
2. **Did NOT bump `ESP_CPU_INT_LINES`** — the CPU genuinely has 32 external
   lines; expanding past 47 would diverge from IDF's CLIC vector table
   (`_mtvt_table` covers causes ≤47) and mis-model the hardware.
3. **AXI-DMA shares ONE combined CPU completion line at cause 47** (the last
   free). Its per-channel INT_RAW/ST/ENA/CLR registers are fully modeled,
   so guest polling + the register-level interrupt behaviour are faithful;
   only the CPU-line granularity is reduced (1 vs the 6 silicon matrix
   sources). AHB-DMA got 6 lines (41-46) only because the budget still
   allowed it then.
4. **Flagged the proper fix as the next phase: model the INTMTX** (128→32
   mux). That both restores per-source CPU-cause fidelity AND unblocks all
   future peripheral interrupts, which the flat scheme can no longer absorb.

### Smaller items
- **mem2mem only.** Peripheral-attached AES/SHA DMA is driven by the crypto
  block's data stream (peri_sel 4/5), not a CPU "start" — modeling that is
  the DMA-crypto phase. `in_link.START` with `MEM_TRANS_EN==0` is a no-op.
- **Instantaneous transfer**; burst/FIFO/CRC config bits stored but inert.
- **Tooling:** ran the self-test from a committed script file (not an inline
  `wsl … bash -lc` long path) — the Git-Bash MSYS path-mangling that blanks
  `$FW` bit me in 2.DJ/2.DK; the script-file form is now the standing rule.

---

## Lessons learned

1. **ETS interrupt-source IDs ≠ CPU CLIC causes.** The P4 has 128 matrix
   sources muxed onto 32 CPU lines by the INTMTX. Any "use the real
   interrupt number" instinct must distinguish *matrix source* from *CPU
   cause*. The model's sequential cause assignment approximates the INTMTX
   allocation; making it truly faithful requires modeling the INTMTX.
2. **The flat 1:1 IRQ-wiring scheme has hit its ceiling.** After AHB-DMA
   (41-46) only cause 47 remains. The interrupt matrix is now the
   highest-leverage next peripheral — it's the real bottleneck.
3. **Identical descriptor format = free reuse.** AXI vs AHB differ in
   register layout but share `dma_descriptor_t`, so the verified
   gather/scatter engine transferred with zero algorithm changes.

## Implementación final (key shape)

- `esp32p4_axi_dma_run_m2m(ch)`: same gather→stage→scatter walk as AHB-DMA,
  AXI offsets; LINK2 writes routed to `in_link_addr[]`/`out_link_addr[]`.
- Single combined `intr_out`: raised iff any channel has
  `(IN_RAW&IN_ENA)|(OUT_RAW&OUT_ENA)`; cleared on INT_CLR.
- Self-test scratch at `0x4FFB1000` (distinct from AHB-DMA's `0x4FFB0000`).

## Estado consolidado (DMA family)

| Engine | Base | Status |
|--------|------|--------|
| AHB-DMA (GDMA) | 0x50085000 | ✅ mem2mem, 3 pairs, 6 IRQ (2.DK) |
| **AXI-DMA (GDMA)** | **0x5008A000** | **✅ mem2mem, 3 pairs, 1 combined IRQ (2.DL); crypto bus** |
| GDMA alias / 2D / DW / H264 | various | not modeled |

## Próximas direcciones (next)

- **INTMTX (interrupt matrix)** — model the 128→32 source→line mux; the
  highest-leverage next step (unblocks all future IRQs + CPU-cause fidelity).
- **DMA-mode AES/SHA** — peri-attach the crypto blocks to AXI-DMA
  (peri_sel 4/5); the real bulk-crypto path.
