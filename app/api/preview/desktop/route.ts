import { previewCwd, previewFailure } from "@/lib/preview-api";
import { previewDesktop } from "@/lib/preview-desktop";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const cwd = await previewCwd(url.searchParams.get("cwd"));
    // Next production uses an internal hostname. The proxy validates the browser's Host.
    url.host = request.headers.get("host") ?? url.host;
    return Response.json(await previewDesktop(cwd, url.origin), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return previewFailure(error);
  }
}
