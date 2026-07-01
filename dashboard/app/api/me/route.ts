import { errorResponse, json, requireSession } from "@/lib/api";

export async function GET() {
  try {
    const session = await requireSession();
    return json(session.user);
  } catch (error) {
    return errorResponse(error);
  }
}
