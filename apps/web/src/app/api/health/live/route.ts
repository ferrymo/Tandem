import { jsonResponse } from '../../../../server/http';
export const dynamic = 'force-dynamic';
export function GET() {
  return jsonResponse({ status: 'alive' });
}
