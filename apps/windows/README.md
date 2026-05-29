# Havyn Windows Rebuild

This is the Windows-first Havyn rebuild using WPF and CefSharp.

The Electron app remains in `apps/desktop`. This project is intentionally separate so the current MVP can be rolled back or shipped while the new shell is built.

## Direction

- Browser-first watch surface powered by embedded Chromium.
- Glassmorphism controls, call tiles, chat, and sync controls designed around fullscreen from the beginning.
- Fullscreen is a native layout state, not a cloned browser or secondary webview.
- Ably, Supabase, room sync, chat, friends, and invite concepts should be carried over as shared app logic.

## Current Prototype

- Loads a real Chromium browser surface.
- Has a mockup-inspired fullscreen-first watch UI.
- Includes top room controls, right-side call/chat glass panels, bottom playback/sync controls.
- Injects a generic HTML5 video detector and reports detected media back to WPF.
- Starts successfully on Windows x64.

## Run

```powershell
dotnet run --project apps/windows/Havyn.Windows.csproj
```

## Build

```powershell
dotnet build apps/windows/Havyn.Windows.csproj
```

## Rollback Points

- `rollback/electron-current-0.1.8`
- `rollback/before-fullscreen-ui`
