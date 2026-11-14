const systemKeys = [
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'TERM',
];
export function runtimeEnv(kind, input = process.env) {
  const keys = [
    ...systemKeys,
    'NODE_ENV',
    'LOG_LEVEL',
    'NEXT_TELEMETRY_DISABLED',
    'SESSION_ENCRYPTION_KEY',
    'TANDEM_PUBLIC_URL',
    'TANDEM_IDENTITY_URL',
    'TANDEM_IDENTITY_ID',
    'TANDEM_IDENTITY_LABEL',
    'TANDEM_COMMANDER_ACCOUNTS',
    'TANDEM_IDENTITY_ALLOW_HTTP',
    'TANDEM_ARTIFACT_ROOT',
    'TANDEM_EXECUTION_IMAGE',
    'MCP_ALLOWED_ORIGINS',
    'MCP_ALLOWED_IMAGES',
    'MODEL_NAME',
    'MODEL_BASE_URL',
    'MODEL_ALLOWED_ORIGINS',
    'MODEL_ALLOW_HTTP',
    ...(kind === 'web'
      ? [
          'DATABASE_URL',
          'TANDEM_ATTACHMENT_ROOT',
          'TANDEM_CONNECTOR_ALLOWED_ORIGINS',
          'TANDEM_CONNECTOR_DB_HOSTS',
          'TANDEM_CONNECTOR_ALLOW_HTTP',
          'TANDEM_CONNECTOR_MYSQL_TLS',
          'PORT',
          'TANDEM_HOST',
          'TANDEM_PUBLIC_URL',
          'SESSION_ENCRYPTION_KEY',
          'TANDEM_IDENTITY_URL',
          'TANDEM_IDENTITY_ID',
          'TANDEM_IDENTITY_LABEL',
          'TANDEM_COMMANDER_ACCOUNTS',
          'TANDEM_IDENTITY_ALLOW_HTTP',
        ]
      : [
          'MODEL_API_KEY',
          'MODEL_ALLOW_HTTP',
          'WORKER_DATABASE_URL',
          'WORKER_POLL_MS',
          'WORKER_LEASE_MS',
          'WORKER_SHUTDOWN_MS',
          'WORKER_HEALTH_FILE',
        ]),
  ];
  return {
    ...Object.fromEntries(
      keys
        .filter((key) => input[key] !== undefined)
        .map((key) => [key, input[key]]),
    ),
    MODEL_CONFIGURED: String(
      Boolean(input.MODEL_BASE_URL && input.MODEL_NAME && input.MODEL_API_KEY),
    ),
  };
}
