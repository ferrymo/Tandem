import { checkReadiness } from '@tandem/application';
import { checkDatabase } from '../../../../server/database';
import { jsonResponse } from '../../../../server/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET() {
  const result = await checkReadiness({ check: checkDatabase });
  return jsonResponse(result, result.status === 'ready' ? 200 : 503);
}
