#!/usr/bin/env bash
# Phase 2.DK — run the AHB-DMA mem2mem self-test and dump its events.
set -u
ROM=/mnt/c/Desarrollo/velxio/third-party/esp-rom-elfs/esp32p4_rev0_rom.elf
FW=/mnt/c/Desarrollo/velxio/test/test-esp32-p4/sketches/blink/build/esp32.esp32.esp32p4/blink.ino.merged.bin
QEMU="$HOME/qemu-p4-build/qemu-system-riscv32"
export VELXIO_GPIO_LOG=/tmp/dma_events.jsonl
rm -f /tmp/dma_events.jsonl /tmp/dma_stderr.txt

timeout 5 "$QEMU" -M esp32p4 -bios "$ROM" \
  -drive file="$FW",if=mtd,format=raw -nographic \
  >/tmp/dma_stdout.txt 2>/tmp/dma_stderr.txt

echo "=== AHB-DMA self-test stderr ==="
grep -i "ahb_dma" /tmp/dma_stderr.txt | head -20
echo "=== DMA JSON events ==="
grep '"event":"dma"' /tmp/dma_events.jsonl 2>/dev/null | head -10
echo "=== regression (ecc + ecdsa still pass) ==="
grep -iE "esp32p4.ecc\] self-test|esp32p4.ecdsa\] self-test" /tmp/dma_stderr.txt | head -8
