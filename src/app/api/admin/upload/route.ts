import { NextRequest, NextResponse } from "next/server";
import { requireAdminToken } from "@/lib/admin/admin-token";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_UPLOAD_SIZE = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const denied = requireAdminToken(req);
  if (denied) return denied;

  try {
    const formData = await req.formData();
    const file = formData.get("file");
    const folder = String(formData.get("folder") || "misc");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "File is required" }, { status: 400 });
    }
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      return NextResponse.json({ error: "File exceeds 8MB limit" }, { status: 400 });
    }

    const ext = file.name.split(".").pop() || "png";
    const safeFolder = folder.replace(/[^a-zA-Z0-9/_-]/g, "");
    const filePath = `${safeFolder}/${crypto.randomUUID()}.${ext}`;

    const supabase = createSupabaseServiceRoleClient();
    const bytes = await file.arrayBuffer();

    const { error } = await supabase.storage
      .from("carousel-media")
      .upload(filePath, bytes, { contentType: file.type, upsert: false });

    if (error) {
      throw error;
    }

    const { data } = supabase.storage.from("carousel-media").getPublicUrl(filePath);

    return NextResponse.json({
      path: filePath,
      publicUrl: data.publicUrl,
    });
  } catch (error) {
    console.error("POST /api/admin/upload failed", error);
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
