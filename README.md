# Lumisend
> Secure, high-density, air-gapped file transfers using custom 4:3 optical light link signals. Powered by client-side browser tech—100% offline, local, and private.

Lumisend is an innovative browser-based visual file transceiver. It converts arbitrary files (text, images, binaries) into high-fidelity structured color/monochrome grids, broadcasts them optically through a monitor display, and decodes them on a target device using a camera lens stream.

---

## Core Features

- **High-Density Optical Signal Modes**: Supports 1-bit monochrome transmission and ultra-fast 3-bit multi-channel color modes spanning variable grid matrices (from low-end 8×6 up to high-capacity 24×18 layouts).
- **Physical L-Anchor Calibration**: Uses a top-left aligned physical machine-vision L-shape reticle to ensure stable angle-agnostic scaling, rotation-tracking, and frame alignment.
- **Selective Repeat ARQ (Bidirectional Correction)**: Shows an automated recovery barcode on the receiver device if frames are missed. The broadcaster's backward link scanner can scan this token, switching into a subset retransmit cycle.
- **Strict Cryptographic CRC-16 Checksums**: Every visual packet contains a CCITT cyclic redundancy check to avoid payload packet corruption due to lighting flickers or camera stutter.
- **Zero Cloud Footprint**: Runs exclusively inside pure client-side sandbox containers. No network sockets are initialized, keeping true private transfers safe.

---

## Technology Stack

- **Framework**: React 18 / TypeScript
- **Bundler**: Vite (fully optimized setup)
- **Visuals & Motion**: Tailwind CSS & Lucide React Icons
- **Targeting**: Native HTML5 Camera APIs (`getUserMedia`)
