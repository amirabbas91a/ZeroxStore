# Changelog

## [2.1.0] - 2026-11-27

### English
- **Complete UI/UX Redesign (Premium Liquid Glass)**: Multi-layer frosted glass surfaces, deep sapphire-obsidian canvas (`#050811`), ambient radial lighting, specular diagonal gradients, glowing glass borders, and animated liquid-glass focus rings across the entire app.
- **Redesigned Smart Download Dashboard**: Live KPI command cards showing Active / Paused / Completed counts, Saved Volume, Live & Peak Speed, Estimated Time Left (ETA), Connection & Persistence status (`Protected`), and per-card percentage + live speed + ETA.
- **Animated Progress & Micro-Interactions**: Smooth 10px Liquid Glass progress bars with multi-stop cyan/blue specular gradients, glowing tip highlight, and animated status indicators.
- **Persistent Download Storage**: Dual atomic disk checkpoints (`downloads.json` with `.tmp`/`.bak` + per-drive `.zerox-queue.json` mirrors) flushed with `sync: true` every 5 ticks / 2 MiB and on every state change & shutdown.
- **Unlimited Console Reboot Recovery & Disk Reconciliation**: Removed the 2-restart auto-resume limit and added full startup reconciliation against `.part`, `.resume`, and final files on disk (including HTML corruption detection and multi-part volume verification).
- **Smart HTTP Range Resume**: Probes `Range: bytes=0-0` (`206 Partial Content`) before resuming, auto-refreshes expired signed links while preserving `.part` files, and handles non-Range (`200 OK`) servers cleanly without silently destroying progress.
- **IDM Download Scheduler & Auto-Retry**: Time-window scheduling (Start Hour / Stop Hour) and configurable disconnect auto-retries (`0`, `3`, `5`, `10`, `20`, `Inf`), plus Store Background Music (BGM) toggle in Settings.
- **About & Changelog Screen**: Added dedicated **About v2.1.0** section inside Settings with synced version metadata (`2.1.0` / `02.100.000`).

### فارسی
- بازنویسی کامل رابط کاربری از صفر با سبک **Premium Liquid Glass** (پنل‌های شیشه‌ای چندلایه، گرادیانت‌های نوری، حاشیه‌های درخشان و فوکوس متحرک).
- بازطراحی کامل **Dashboard هوشمند دانلود** با نمایش تعداد دانلودهای فعال/متوقف/تکمیل‌شده، حجم ذخیره‌شده، سرعت لحظه‌ای و اوج، زمان تخمینی (ETA)، درصد پیشرفت زنده و وضعیت پایداری ذخیره‌سازی.
- اضافه شدن **Persistent Download Storage** با ذخیره اتمی دوگانه (`sync: true`) روی حافظه کنسول و درایو مقصد برای حفظ ۱۰۰٪ دانلودها پس از خاموش/روشن شدن کنسول و قطع برق.
- اضافه شدن **Smart Resume** با بررسی فایل‌های `.part` و `.resume`، پشتیبانی از HTTP Range (`206`)، رفرش خودکار لینک‌های منقضی‌شده بدون حذف فایل نیمه‌تمام و مدیریت سرورهای بدون Range.
- حفظ دانلودهای همزمان و وضعیت دقیق هرکدام پس از راه‌اندازی مجدد و حذف محدودیت تعداد دفعات ریبوت.
- اضافه شدن زمان‌بندی دانلود شبیه **IDM**، تنظیم تعداد تلاش مجدد خودکار هنگام قطعی نت، گزینه قطع/وصل آهنگ پس‌زمینه (BGM) و بخش **About v2.1.0** در تنظیمات.

---

## [1.0.2] - 2026-11-27
- Initial IDM download scheduler, disconnect auto-retry, `.part` resume pass, and `param.json` version sync (`01.002.000`).

## [1.0.1] - 2026-11-27
- Replaced embedded top-left `icon0` texture inside `eboot.bin` and configured GitHub self-updater.

## [1.0.0] - 2026-11-27
- Initial ZeroxStore rebrand with PlayStation Store styling and file-size badges.
