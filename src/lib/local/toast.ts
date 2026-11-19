import { spawn } from "node:child_process";

/**
 * A Windows notification from the running app, for when no browser tab is open. It uses the toast API that ships with Windows (no
 * module, no installer), with PowerShell's own registered app id so Windows accepts it. Clicking it opens the address given, which is
 * always this app's own (127.0.0.1). Nothing is sent anywhere.
 */
export type Toast = { title: string; body: string; url: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function toastXml(t: Toast): string {
  return `<toast activationType="protocol" launch="${esc(t.url)}"><visual><binding template="ToastGeneric"><text>${esc(t.title.slice(0, 120))}</text><text>${esc(t.body.slice(0, 200))}</text></binding></visual></toast>`;
}

/** The PowerShell that shows the toast. The XML travels base64-encoded, so no text from a notification is ever part of a command line. */
export function toastScript(t: Toast): string {
  const b64 = Buffer.from(toastXml(t), "utf8").toString("base64");
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($toast)",
  ].join("\n");
}

/** Fire and forget; a failure to notify must never affect the app. Windows only. */
export function showWindowsToast(t: Toast): void {
  if (process.platform !== "win32") return;
  try {
    const encoded = Buffer.from(toastScript(t), "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], { windowsHide: true, stdio: "ignore", shell: false });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no toast
  }
}
