# Piskie logo system

The current application mark is concept `05-E-p-stem-emphasis`. It keeps the compact circular silhouette and directional opening while making the negative-space P clearer at small sizes.

## Required assets

- `app/piskie-brand-on-dark-1024.png`: static light-on-dark electron-builder icon source.
- `app/piskie-brand-on-dark-256.png` and `app/piskie-brand-on-light-256.png`: canonical application-theme variants for packaging, macOS Dock, and Linux window icons.
- `app/piskie-tray-glyph-128.png`: light tray glyph and macOS template mask.
- `app/piskie-tray-glyph-dark-128.png`: dark tray glyph for light Windows system UI.
- `app/piskie-brand.ico`: high-contrast Windows taskbar, window, and installer icon with 16, 32, 48, 64, 128, and 256 pixel frames.
- `../../public/favicon.png`: browser favicon.
- `../../public/logo-64.png` and `../../public/logo-128.png`: renderer brand marks.
- `../../public/logo-on-light-128.png` and `../../public/logo-on-dark-128.png`: renderer theme variants.

The PNG assets are RGBA files with transparent corners. Runtime theme variants share one alpha mask with the canonical mark.

## Trademark use

These assets identify the official Piskie project. Their use as trademarks is governed by [`TRADEMARKS.md`](../../TRADEMARKS.md), separately from the MIT license for the source code.
