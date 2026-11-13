export type CapabilityEffect = 'read' | 'write' | 'unknown';
export * from './management';
export type CapabilityVersion = Readonly<{
  id: string;
  version: string;
  contentHash: string;
  enabled: boolean;
}>;
export function mayInvokeRead(
  effect: CapabilityEffect,
  authorized: boolean,
  enabled: boolean,
): boolean {
  return effect === 'read' && authorized && enabled;
}
