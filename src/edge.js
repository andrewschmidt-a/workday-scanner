import { spawn } from 'node:child_process';

export async function openEdge(url) {
  if (process.platform !== 'win32') {
    throw new Error('Opening the normal Edge profile is supported on Windows only.');
  }
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:WORKDAY_TRACKER_EDGE_URI",
    ], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, WORKDAY_TRACKER_EDGE_URI: `microsoft-edge:${url}` },
    });
    child.once('error', () => reject(new Error('Could not open Microsoft Edge. Open the configured Workday URL manually.')));
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error('Microsoft Edge could not be opened. Open the configured Workday URL manually.')));
  });
}
