import { collaborationConfig } from '../../../server/collaboration';
import { handle, requireSession } from '../../../server/collaboration-http';
import { jsonResponse } from '../../../server/http';

export function GET() {
  return handle(async () => {
    const session = await requireSession();
    const config = collaborationConfig();
    return jsonResponse({
      connection: {
        id: config.TANDEM_IDENTITY_ID,
        label: config.TANDEM_IDENTITY_LABEL,
        kind: 'zentao',
        configured: true,
      },
      authorization: {
        status: 'authorized',
        displayName: session.identity.displayName,
      },
    });
  });
}
