# Piskie logo system

The current application mark is concept `05-E-p-stem-emphasis`. It keeps the compact circular silhouette and directional opening while making the negative-space P clearer at small sizes.

## Theme variants

`on-light` and `on-dark` name the background the mark is intended for. Both variants use the existing Windows tray palette:

- `on-light`: dark artwork (`#20211F`) for light backgrounds.
- `on-dark`: light artwork (`#F2F0E8`) for dark backgrounds.

Both variants use the same transparent silhouette. The 1024px PNGs in `app/` are suitable for avatar uploads; choose the variant for the intended background. [Preview both variants](preview/piskie-theme-variants.png) composited on their intended backgrounds.

## Required assets

- `app/piskie-brand-on-light-1024.png` and `app/piskie-brand-on-dark-1024.png`: high-resolution transparent PNGs. The light artwork remains the static electron-builder icon source.
- `app/piskie-brand-on-light-256.png` and `app/piskie-brand-on-dark-256.png`: application-theme variants for macOS Dock and Linux window icons. Linux packaging uses the light artwork.
- `app/piskie-tray-glyph-128.png`: existing light glyph (`#F2F0E8`) for dark Windows system UI and Linux trays; macOS uses its alpha as a template mask.
- `app/piskie-tray-glyph-dark-128.png`: existing dark glyph (`#20211F`) for light Windows system UI. Windows tray selection follows the system theme.
- `app/piskie-brand.ico`: fixed light artwork (`#F2F0E8`) for Windows taskbar, window, and installer icons, with 16, 32, 48, 64, 128, and 256 pixel frames.
- `../../public/logo-on-light-128.png` and `../../public/logo-on-dark-128.png`: renderer marks selected by the application theme. The favicon reuses these PNGs, with dark artwork as the default and light artwork for a dark browser theme.

## Trademark use

These assets identify the official Piskie project. Their use as trademarks is governed by [`TRADEMARKS.md`](../../TRADEMARKS.md), separately from the MIT license for the source code.
