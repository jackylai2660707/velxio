#!/usr/bin/env bash
# Phase 2.DQ — run the I2S0 TX-via-AHB-DMA self-test.
set -u
ROM=/mnt/c/Desarrollo/velxio/third-party/esp-rom-elfs/esp32p4_rev0_rom.elf
FW=/mnt/c/Desarrollo/velxio/test/test-esp32-p4/sketches/blink/build/esp32.esp32.esp32p4/blink.ino.merged.bin
QEMU="$HOME/qemu-p4-build/qemu-system-riscv32"
export VELXIO_GPIO_LOG=/tmp/i2s_events.jsonl
rm -f /tmp/i2s_events.jsonl /tmp/i2s_stderr.txt

timeout 5 "$QEMU" -M esp32p4 -bios "$ROM" \
  -drive file="$FW",if=mtd,format=raw -nographic \
  >/tmp/i2s_stdout.txt 2>/tmp/i2s_stderr.txt

echo "=== I2S self-test + op ==="
grep -iE "esp32p4.i2s\]" /tmp/i2s_stderr.txt | head
echo "=== i2s JSON event ==="
grep '"event":"i2s"' /tmp/i2s_events.jsonl 2>/dev/null | head
echo "=== regression (AHB-DMA + AES-DMA) ==="
grep -iE "ahb_dma\] self-test A|self-test DMA: ECB128" /tmp/i2s_stderr.txt | head -2
