# ZeroxStore v2.1.0

**ZeroxStore** (`PPSA99059`) is a **PS5 Homebrew Game Store** rebuilt with a **Premium Liquid Glass** UI/UX, a **Persistent Download Storage** engine, and **Smart HTTP Range Resume**.

## What's New in v2.1.0

- **Premium Liquid Glass UI/UX**: Multi-layer frosted glass cards, deep midnight sapphire canvas (`#050811`) with ambient radial lighting, specular reflections, glowing focus rings, redesigned v2.1.0 Liquid Glass welcome splash, cinematic hero scrims, and an **About v2.1.0** tab in Settings.
- **Smart Download Command Dashboard**: Displays Active / Paused / Completed counts, Saved Volume, Live Speed & Peak Speed, ETA, Connection & Persistence status (`Protected`), drive storage pills, and animated 10px cyan/blue progress bars with live percentage (`%`).
- **Persistent Download System (Survives Console Power-Off)**:
  - Atomic queue checkpoints (`downloads.json` + `.tmp` + `.bak`) plus redundant per-drive `.zerox-queue.json` mirrors written with `sync: true`.
  - Startup disk reconciliation verifies `.part`, `.resume`, and multi-part volumes directly from disk so progress is never lost even on sudden power cuts or repeated console reboots.
- **Smart HTTP Range Resume**:
  - Validates partial files (rejecting corrupt HTML error headers) and probes `Range: bytes=0-0` (`206 Partial Content`) before resuming.
  - Automatically refreshes expired hoster links while preserving `.part` files on disk, and safely handles servers that do not support HTTP Range.
- **IDM Scheduler, Auto-Retry & Audio Toggle**:
  - Built-in **Download Scheduler (IDM)** with Start/Stop hour controls and configurable disconnect auto-retries (`0`, `3`, `5`, `10`, `20`, `Inf`) in **Settings -> Downloads**.
  - **Store Music (BGM)** on/off toggle in **Settings -> Sound**.

## Verification & Automated Tests

Run the automated Persistent Download & Smart Resume suite (executes the extracted `eboot.bin` queue engine against a real local filesystem and real `HTTP 206` / `200` / `403` Range server):

```bash
node tests/persistent-download.test.mjs
```

Verified scenarios:
1. **Abrupt App Close (~37%)**: Closes mid-download, boots fresh engine from disk, resumes from `>=37%`, verifies exact SHA-256.
2. **Sudden Console Power-Off (~63% x 3 Reboots)**: Simulates 3 consecutive cold restarts without flush, reconciles `.part` on disk, completes with exact SHA-256.
3. **Network Disconnect Mid-Stream**: Destroys TCP socket mid-transfer, preserves `.part`, auto-retries, completes with exact SHA-256.
4. **Concurrent Multi-Download Recovery**: Verifies active, manually paused, and queued downloads retain exact independent states across restarts.
5. **Smart Resume & IDM Scheduler**: Verifies expired `HTTP 403` signed-URL refresh without deleting `.part`, non-Range `HTTP 200` detection/fallback, and IDM time-window gating.

## Installation (PS5)

1. Download **`ZeroxStore.exfat`** from the [Latest Release](https://github.com/amirabbas91a/ZeroxStore/releases/latest) (once built & uploaded for `v2.1.0`).
2. Transfer it to your PS5 and mount/install using ShadowMount or Itemzflow (or copy the root folder directly).

## Credits

- Built upon the open-source [B4ckd0orl/Padrino-Store](https://github.com/B4ckd0orl/Padrino-Store) project.
