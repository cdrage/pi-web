import { NextRequest } from "next/server";
import { previewService } from "@/lib/pd-preview";
import { previewBody, previewCwd, previewFailure } from "@/lib/preview-api";
import { PREVIEW_ACTIONS, PreviewError, type PreviewAction, type PreviewTarget } from "@/packages/pi-pd-preview/model";
import { parseOptions } from "@/packages/pi-pd-preview/github";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  try {
    const cwd = await previewCwd(request.nextUrl.searchParams.get("cwd"));
    const service = previewService();
    const result = request.nextUrl.searchParams.get("view") === "logs"
      ? { lines: await service.logs(cwd) }
      : await service.status(cwd, request.nextUrl.searchParams.get("fresh") === "1");
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    return previewFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await previewBody(request);
    const cwd = await previewCwd(body.cwd);
    if (typeof body.action !== "string" || !PREVIEW_ACTIONS.includes(body.action as PreviewAction)) {
      throw new PreviewError("Invalid preview action.");
    }
    const options = parseOptions(body.options ?? {});
    const target = body.target as PreviewTarget | undefined;
    if (!target || typeof target !== "object" || typeof target.root !== "string"
      || target.branch !== null && typeof target.branch !== "string") {
      throw new PreviewError("Provide the worktree and branch from the preview card.");
    }
    return Response.json(await previewService().action(cwd, body.action as PreviewAction, options, target), { headers: NO_STORE });
  } catch (error) {
    return previewFailure(error);
  }
}
