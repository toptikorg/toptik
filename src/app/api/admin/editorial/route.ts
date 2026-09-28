import { NextRequest, NextResponse } from "next/server";
import { supabaseEnv } from "@/lib/supabase/env";
import { getPublicCatalog } from "@/lib/carousel/public-catalog";
import { saveEditorial } from "@/lib/carousel/editorial-repository";
import { editorialIdSchema, editorialSchema } from "@/lib/carousel/editorial-schema";
import { catalogIdentity } from "@/lib/carousel/storefront-projection";
const authorized = (req: NextRequest) => Boolean(supabaseEnv.adminToken && req.headers.get("x-admin-token") === supabaseEnv.adminToken);
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const payload = await getPublicCatalog();
    return NextResponse.json({ items: payload.items.map(i => ({ id: i.id, catalogNumber: i.catalogNumber, editorial: i.editorial, showroomUrl: i.showroomUrl })) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "לא ניתן לטעון את הקטלוג" }, { status: 503 }); }
}
export async function PUT(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const id = editorialIdSchema.parse(body.id);
    const input = editorialSchema.parse(body.editorial);
    const payload = await getPublicCatalog();
    const item = payload.items.find(i => i.id === id);
    if (!item) return NextResponse.json({ error: "המוצר אינו בקטלוג הציבורי" }, { status: 404 });
    if (input.expectedSku !== catalogIdentity(item.catalogNumber)) return NextResponse.json({ error: "המק״ט השתנה מאז הטעינה. טענו מחדש ובדקו את התוכן מול הדגם." }, { status: 409 });
    const editorial = await saveEditorial(id, input);
    return NextResponse.json({ ok: true, editorial }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "השמירה לא אומתה. בדקו את השדות ונסו שוב." }, { status: 400 }); }
}
