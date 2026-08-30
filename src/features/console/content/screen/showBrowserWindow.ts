export async function showBrowserWindow(browserId: string): Promise<void> {
  try {
    await window.piskie.pilot.screen.show(browserId);
  } catch {
    // The preview remains usable when the native browser window cannot be focused.
  }
}
