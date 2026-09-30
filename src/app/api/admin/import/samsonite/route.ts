import { createImportRouteHandler } from "@/lib/import/import-handler";

export const runtime = "nodejs";
export const maxDuration = 120;

export const POST = createImportRouteHandler("samsonite");
