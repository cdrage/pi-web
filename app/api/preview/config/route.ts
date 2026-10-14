import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { configView, saveConfig } from "@/packages/pi-pd-preview/storage";
import { parseOidc } from "@/packages/pi-pd-preview/oidc-config";
import { previewService } from "@/lib/pd-preview";
import { PreviewError } from "@/packages/pi-pd-preview/model";
import { previewBody, previewFailure } from "@/lib/preview-api";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    return Response.json(await configView(getAgentDir()), { headers: NO_STORE });
  } catch (error) {
    return previewFailure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await previewBody(request);
    if (typeof body.apiUrl !== "string" || body.token !== undefined && typeof body.token !== "string"
      || Object.keys(body).some((key) => key !== "apiUrl" && key !== "token" && key !== "oidc")) {
      throw new PreviewError("Provide an API address and an optional token.");
    }
    const oidc = body.oidc == null ? body.oidc as null | undefined : parseOidc(body.oidc);
    return Response.json(await saveConfig(getAgentDir(), { apiUrl: body.apiUrl, token: body.token as string | undefined, oidc }), { headers: NO_STORE });
  } catch (error) {
    return previewFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    await previewBody(request);
    return Response.json(await previewService().check(), { headers: NO_STORE });
  } catch (error) {
    return previewFailure(error);
  }
}
