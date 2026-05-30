#!/usr/bin/env bash
# Phase 2.DJ — run the ECC_MULT self-test and dump its events.
set -u
ROM=/mnt/c/Desarrollo/velxio/third-party/esp-rom-elfs/esp32p4_rev0_rom.elf
FW=/mnt/c/Desarrollo/velxio/test/test-esp32-p4/sketches/blink/build/esp32.esp32.esp32p4/blink.ino.merged.bin
QEMU="$HOME/qemu-p4-build/qemu-system-riscv32"
export VELXIO_GPIO_LOG=/tmp/ecc_events.jsonl
rm -f /tmp/ecc_events.jsonl /tmp/ecc_stderr.txt

timeout 5 "$QEMU" -M esp32p4 -bios "$ROM" \
  -drive file="$FW",if=mtd,format=raw -nographic \
  >/tmp/ecc_stdout.txt 2>/tmp/ecc_stderr.txt

echo "=== ECC self-test stderr ==="
grep -i "esp32p4.ecc" /tmp/ecc_stderr.txt | head -40
echo "=== ECC JSON events ==="
grep '"event":"ecc"' /tmp/ecc_events.jsonl 2>/dev/null | head -40
echo "=== ecdsa link sanity (prior phase still works) ==="
grep -i "esp32p4.ecdsa" /tmp/ecc_stderr.txt | head -6
