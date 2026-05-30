# Phase 2.DK — AHB-DMA (GDMA) controller, scatter-gather mem2mem

**Estado:** ✅ DONE — real peripheral at `0x50085000`, 3 RX/TX channel
pairs, linked-list descriptors, memory-to-memory transfers verified in
running QEMU (single-desc + gather 2→1 + scatter 1→2, all byte-exact).
6 IRQ lines → CLIC causes 41-46. First DMA engine in the model.

Files:
- `third-party/qemu-lcgamboa/hw/misc/esp32p4_dma.c` (new, ~430 lines)
- `third-party/qemu-lcgamboa/include/hw/misc/esp32p4_dma.h` (new)
- `third-party/qemu-lcgamboa/hw/misc/meson.build` (+1 line)
- `third-party/qemu-lcgamboa/hw/riscv/esp32p4.c` (include + struct field +
  init block at 0x50085000 + 6-line IRQ wiring + self-test call)
- `test/test-esp32-p4/autosearch/scripts/run_dma_selftest.sh` (run harness)

---

## SE INVESTIGÓ (what was researched)

The AHB-DMA (a.k.a. GDMA / AHB_PDMA) is the general-purpose scatter-gather
DMA engine — the thing `esp_async_memcpy` uses for mem2mem and that
SPI/I2S/UHCI/etc. attach to for streaming. It is the foundational piece
that future DMA-mode peripherals build on.

Two grounding tracks ran in parallel:

1. **Direct IDF reads** (independent grounding): `soc/ahb_dma_reg.h`,
   `soc/ahb_dma_struct.h`, `hal/ahb_dma_ll.h`, `hal/include/hal/dma_types.h`,
   `soc/reg_base.h`, `soc/soc_caps.h`. Established the base
   (`DR_REG_HPPERIPH0_BASE 0x50000000 + 0x85000 = 0x50085000`), the
   per-channel layout, the descriptor format, and the M2M enable path.

2. **A lean `ahb-dma-research` Workflow** (4 parallel readers → synthesis):
   `read:ahb-regs`, `read:descriptor`, `read:m2m-flow`, `read:instantiation`.
   It **completed cleanly** (no session-limit fallout) and **confirmed every
   value I'd derived**, plus added two facts I hadn't pinned: the 6 distinct
   interrupt sources and that **AES/SHA use AXI-DMA, not AHB-DMA**.

### Register map (base 0x50085000, confirmed both ways)
- **Five independent per-channel groupings**, not one contiguous block:
  - `in_intr[3]` @ 0x00, stride 0x10 (RAW/ST/ENA/CLR @ +0/4/8/C)
  - `out_intr[3]` @ 0x30, stride 0x10
  - `channel[3]` @ 0x70, stride **0xC0**: IN sub-block @ +0x00
    (IN_CONF0, IN_LINK@+0x10, IN_SUC_EOF_DES_ADDR@+0x18, IN_PERI_SEL@+0x30),
    OUT sub-block @ +0x60 (OUT_CONF0, OUT_LINK@+0x70, OUT_EOF_DES_ADDR@+0x78,
    OUT_PERI_SEL@+0x90)
  - `in_link_addr[3]` @ 0x3AC, stride 0x4 — **full 32-bit RX descriptor base**
  - `out_link_addr[3]` @ 0x3B8, stride 0x4 — **full 32-bit TX descriptor base**
  - MISC_CONF @ 0x64, DATE @ 0x68 (default 36712768)
- **IN_LINK** (0x80): AUTO_RET[0] STOP[1] **START[2]** RESTART[3] PARK[4].
- **OUT_LINK** (0xE0): STOP[0] **START[1]** RESTART[2] PARK[3] —
  *shifted by one* vs IN (no auto_ret on the TX side).
- **MEM_TRANS_EN = IN_CONF0[4]** on the RX channel (mem2mem switch).
- IN INT bits: IN_DONE[0] **IN_SUC_EOF[1]** IN_ERR_EOF[2] IN_DSCR_ERR[3] …
- OUT INT bits: OUT_DONE[0] OUT_EOF[1] OUT_DSCR_ERR[2] OUT_TOTAL_EOF[3] …

### Descriptor (`dma_descriptor_t`)
`dw0 { size[11:0], length[23:12], err_eof[28], suc_eof[30], owner[31] }`,
`word1 = buffer ptr`, `word2 = next ptr (0 = last)`. owner: 0=CPU, 1=DMA;
the engine returns ownership (owner→0) on completion.

---

## SÍ funcionó (what worked)

- **Independent grounding + workflow confirmation.** Reading the IDF
  myself first (then having the workflow confirm) meant I could write the
  header before the workflow even returned, and the workflow's job became
  *adversarial verification* rather than discovery. Every offset matched.
- **mem2mem trigger latch.** A copy fires once the channel has
  `MEM_TRANS_EN` set AND both `out_link.START` and `in_link.START` have
  been written (tracked by `in_started`/`out_started` flags, cleared after
  the run) — robust to either start order, matching the
  reset→mem_trans→addrs→out.start→in.start driver sequence.
- **Descriptor-chain walking both ways.** Gather (source chain longer than
  one) and scatter (dest chain longer than one) both walk correctly; the
  RX write-back stamps each consumed descriptor's `length` and clears
  `owner`, setting `suc_eof` only on the descriptor that receives the final
  byte — verified by the scatter test reading back dw0 of both RX descriptors.
- **Self-test in running QEMU** (L2MEM scratch @ 0x4FFB0000, exercised
  through the real MMIO `write` path):
  ```
  self-test A single-desc copy=OK writeback=OK
  self-test B gather 2->1=OK
  self-test C scatter 1->2=OK writeback=OK
  ```
  3 `dma` JSON events; ECC + ECDSA regressions still green.

---

## NO funcionó / decisiones (what failed + decisions made)

- **Empty self-test output (tooling, not code).** The first run produced
  no output at all — same Git-Bash-mangles-the-long-`$FW`-path issue hit in
  Phase 2.DJ. The inline `wsl.exe … bash -lc '…long /mnt/c/… path…'` form
  silently blanks the firmware path. **Fix:** run from a committed script
  file (`run_dma_selftest.sh`) — MSYS path conversion doesn't touch the
  here-path then. (Lesson re-learned: always use a script file for the
  QEMU launch, never an inline long path.)
- **Combined vs separate IRQ lines.** Initial draft used one combined line
  per channel (the ESP32-C3 GDMA precedent in this tree). The workflow
  showed P4 exposes **6 distinct interrupt sources** (ETS_AHB_PDMA_IN_CH0..2
  + OUT_CH0..2). **Decision:** model 6 lines (irq_in[3] + irq_out[3]) for
  silicon fidelity → CLIC causes 41-46 (47 still free under the 48-line
  budget). RX completion drives `irq_in[ch]`, TX completion `irq_out[ch]`.
- **Scope: mem2mem only.** Peripheral-attached DMA (SPI/I2S/UHCI) sets up
  the *same* descriptors but is clocked by the peripheral's data stream,
  not the CPU — there is no register write that "starts" a peripheral DMA
  burst in isolation, so it can't be self-tested standalone and isn't
  modeled. `in_link.START` with `MEM_TRANS_EN==0` is a no-op (documented).
- **AES/SHA need AXI-DMA, not this.** The workflow found ESP32-P4 routes
  AES/SHA DMA to the **separate AXI-DMA controller @ 0x5008A000**. So this
  phase does not (yet) give DMA-mode crypto; that's a clean follow-up
  (same descriptor format, different base + bus width). Noted in "next".
- **Instantaneous transfer.** The copy completes synchronously inside the
  triggering MMIO write (no cycle accounting, no FIFO/burst modeling). The
  burst/priority/ETM config bits are stored but inert. Acceptable: guests
  poll INT_RAW or take the completion IRQ, both of which are correct.

---

## Lessons learned

1. **Ground independently, then let the workflow adversarially confirm.**
   Doing the IDF reads myself first made the workflow a *verification*
   pass, not a discovery pass — faster, and it surfaced exactly the two
   deltas I'd missed (6 IRQ sources, AXI-vs-AHB for crypto) instead of
   re-deriving what I already knew.
2. **Modern ESP GDMA puts the descriptor address in a SEPARATE register.**
   The `IN_LINK`/`OUT_LINK` registers are control-only on P4 (v2); the
   32-bit base lives in `IN_LINK_ADDR`/`OUT_LINK_ADDR` @ 0x3AC/0x3B8. The
   18-bit `*LINK_DSCR_ADDR` field inside IN_LINK/OUT_LINK is RO *status*,
   not the programming input — easy to mis-model from the reg header alone.
3. **OUT_LINK bit positions are shifted by one vs IN_LINK** (no AUTO_RET on
   TX): START is bit2 for IN, bit1 for OUT. A copy-paste would silently
   break the TX trigger.
4. **Always launch QEMU from a script file under WSL** — inline long
   `/mnt/c/…` paths get blanked by Git Bash's MSYS path conversion.

## Implementación final (key shape)

- `esp32p4_dma_run_m2m(ch)`: gather TX chain into a 16 KB staging buffer
  (loop-guarded ≤64 descriptors, ≤16 KB), scatter into the RX chain
  honoring each RX descriptor's `size`, write back owner/length/suc_eof,
  set IN_SUC_EOF_DES_ADDR / OUT_EOF_DES_ADDR, raise IN_SUC_EOF+IN_DONE on
  RX and OUT_EOF+OUT_TOTAL_EOF+OUT_DONE on TX, emit a `dma` event, update
  both IRQ lines.
- Guest memory via `address_space_read/write(&address_space_memory, …,
  MEMTXATTRS_UNSPECIFIED, …)` — same idiom as the eFuse/chip_info self-test.

## Estado consolidado (DMA family)

| Engine | Base | Status |
|--------|------|--------|
| **AHB-DMA (GDMA)** | **0x50085000** | **✅ mem2mem, 3 pairs, 6 IRQ (2.DK)** |
| AXI-DMA | 0x5008A000 | ⏭️ planned (DMA-mode AES/SHA) |
| GDMA (alias) | 0x50081000 | n/a |
| 2D-DMA / DW_GDMA / H264-DMA | various | not modeled |

## Próximas direcciones (next)

- AXI-DMA @ 0x5008A000 → wire DMA-mode AES (CBC/CTR/GCM) + DMA-SHA.
- Peripheral-attached AHB-DMA (SPI/I2S streaming) once a consumer needs it.
- Cycle-accurate / chunked transfer + FIFO depth if timing fidelity matters.
