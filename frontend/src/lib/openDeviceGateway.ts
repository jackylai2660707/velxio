/**
 * openDeviceGateway
 *
 * Opens an emulated board's IoT-gateway page inside an in-app iframe panel
 * (same tab) instead of a new browser tab.
 *
 * Why: the Raspberry Pi Pico W emulation runs in THIS browser tab, driven by
 * requestAnimationFrame. Opening the gateway in a new tab backgrounds the
 * emulation tab, the browser pauses its rAF, the simulated chip freezes, and
 * the gateway can no longer reach the server running on it (the request times
 * out / returns 502). Rendering the served page in an iframe keeps the
 * emulation tab in the foreground, so the chip keeps running and answers.
 *
 * (The ESP32 doesn't need this — its server runs in QEMU on the backend, which
 * is unaffected by browser tab visibility.)
 *
 * Plain DOM, no React state, so it can be invoked from anywhere (serial-monitor
 * link, canvas WiFi badge) without threading props.
 */

const OVERLAY_ID = 'velxio-device-gateway-overlay';

export function openDeviceGateway(url: string): void {
  if (typeof document === 'undefined') return;
  document.getElementById(OVERLAY_ID)?.remove();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);' +
    'display:flex;align-items:center;justify-content:center;';

  const panel = document.createElement('div');
  panel.style.cssText =
    'background:#1e1e1e;border:1px solid #3a3a3a;border-radius:10px;' +
    'width:min(440px,94vw);height:min(640px,90vh);display:flex;' +
    'flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,0.5);';

  const bar = document.createElement('div');
  bar.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:12px;' +
    'padding:8px 12px;background:#252526;color:#ddd;' +
    'font:13px -apple-system,BlinkMacSystemFont,sans-serif;border-bottom:1px solid #3a3a3a;';

  const title = document.createElement('span');
  title.textContent = 'Device web page (IoT Gateway)';
  title.style.cssText = 'font-weight:600;';

  const right = document.createElement('div');
  right.style.cssText = 'display:flex;align-items:center;gap:14px;';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.style.cssText = 'background:none;border:none;color:#4fc3f7;cursor:pointer;font-size:13px;padding:0;';

  const openTab = document.createElement('a');
  openTab.textContent = 'Open in tab';
  openTab.href = url;
  openTab.target = '_blank';
  openTab.rel = 'noreferrer';
  openTab.style.cssText = 'color:#4fc3f7;text-decoration:none;font-size:13px;';

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.style.cssText = 'background:#3a3a3a;border:none;color:#fff;cursor:pointer;font-size:13px;border-radius:5px;padding:4px 10px;';

  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.cssText = 'flex:1;border:none;width:100%;background:#fff;';

  reload.onclick = () => { iframe.src = url; };
  const dismiss = () => overlay.remove();
  close.onclick = dismiss;
  overlay.onclick = (e) => { if (e.target === overlay) dismiss(); };

  right.append(reload, openTab, close);
  bar.append(title, right);
  panel.append(bar, iframe);
  overlay.append(panel);
  document.body.append(overlay);
}
