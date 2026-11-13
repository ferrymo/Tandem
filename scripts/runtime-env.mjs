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
    ...(kind === 'web'
      ? [
          'DATABASE_URL',
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
          'WORKER_DATABASE_URL',
          'WORKER_POLL_MS',
          'WORKER_LEASE_MS',
          'WORKER_SHUTDOWN_MS',
          'WORKER_HEALTH_FILE',
        ]),
  ];
  return Object.fromEntries(
    keys
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
}
