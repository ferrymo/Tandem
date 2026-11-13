import { randomUUID } from 'node:crypto';
export function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Request-Id': randomUUID() },
  });
}
