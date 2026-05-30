#!/usr/bin/env bash
# Phase 2.DL — run the AXI-DMA mem2mem self-test and dump its events.
set -u
ROM=/mnt/c/Desarrollo/velxio/third-party/esp-rom-elfs/esp32p4_rev0_rom.elf
FW=/mnt/c/Desarrollo/velxio/test/test-esp32-p4/sketches/blink/build/esp32.esp32.esp32p4/blink.ino.merged.bin
QEMU="$HOME/qemu-p4-build/qemu-system-riscv32"
export VELXIO_GPIO_LOG=/tmp/axidma_events.jsonl
rm -f /tmp/axidma_events.jsonl /tmp/axidma_stderr.txt

timeout 5 "$QEMU" -M esp32p4 -bios "$ROM" \
  -drive file="$FW",if=mtd,format=raw -nographic \
  >/tmp/axidma_stdout.txt 2>/tmp/axidma_stderr.txt

echo "=== AXI-DMA self-test stderr ==="
grep -i "axi_dma" /tmp/axidma_stderr.txt | head -20
echo "=== axi_dma JSON events ==="
grep '"event":"axi_dma"' /tmp/axidma_events.jsonl 2>/dev/null | head -10
echo "=== regression (AHB-DMA + ECC still pass) ==="
grep -iE "esp32p4.ahb_dma\] self-test|esp32p4.ecc\] self-test point_mul P256" /tmp/axidma_stderr.txt | head -5
