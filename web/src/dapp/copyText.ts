// Clipboard helper shared by the footer install pill and the swap-form CLI
// copy button. Falls back to a prompt when navigator.clipboard is unavailable
// (non-secure contexts / denied permission).

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      window.prompt("Copy to clipboard:", text);
      return true;
    } catch {
      return false;
    }
  }
}
