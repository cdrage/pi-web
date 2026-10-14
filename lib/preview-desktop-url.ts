/** Let Kasm fit the desktop resolution to the live iframe viewport. */
export function desktopUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("resize", "remote");
  return url.href;
}
