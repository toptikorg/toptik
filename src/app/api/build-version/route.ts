// Only the public repository commit is exposed. Missing Vercel metadata must
// remain an explicit unknown, never an assumed match.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (!sha || !/^[a-f0-9]{40}$/i.test(sha)) {
    return Response.json({ error: "BUILD_COMMIT_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
  return Response.json({ commit: sha.toLowerCase() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
