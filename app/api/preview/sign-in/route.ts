import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { cancelOidcLogin, finishOidcLogin, readOidcLogin, signOutOidc, startOidcLogin } from "@/packages/pi-pd-preview/oidc-login";
import { PreviewError } from "@/packages/pi-pd-preview/model";
import { previewBody, previewFailure } from "@/lib/preview-api";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const HTTP_FORBIDDEN = 403;

export async function GET(request: Request) {
  try {
    if (!isApiRequestAllowed(request)) {
      throw new PreviewError("Untrusted API request.", HTTP_FORBIDDEN);
    }
    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      throw new PreviewError("Provide a sign-in ID.");
    }
    return Response.json(readOidcLogin(getAgentDir(), id), { headers: NO_STORE });
  } catch (error) {
    return previewFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await previewBody(request);
    if (Object.keys(body).some((key) => !["action", "id", "redirectUrl"].includes(key))) {
      throw new PreviewError("Invalid sign-in request.");
    }
    const dir = getAgentDir();
    if (body.action === "start") {
      return Response.json(await startOidcLogin(dir), { headers: NO_STORE });
    }
    if (body.action === "logout") {
      await signOutOidc(dir);
      return Response.json({ signedOut: true }, { headers: NO_STORE });
    }
    if (typeof body.id !== "string") {
      throw new PreviewError("Provide a sign-in ID.");
    }
    if (body.action === "cancel") {
      return Response.json(cancelOidcLogin(dir, body.id), { headers: NO_STORE });
    }
    if (body.action === "finish" && typeof body.redirectUrl === "string") {
      return Response.json(await finishOidcLogin(dir, body.id, body.redirectUrl), { headers: NO_STORE });
    }
    throw new PreviewError("Invalid sign-in action.");
  } catch (error) {
    return previewFailure(error);
  }
}
