export function LogoMark({ size = 22 }: { size?: number }) {
  /** Tandem 符号：双人自行车的抽象——两条并行线在若干节拍交会 */
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Tandem">
      <path d="M3 17 L21 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M3 7 L21 17" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  );
}

export function Logo({ size = 22, withName = true }: { size?: number; withName?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 9, color: "var(--text-1)" }}>
      <LogoMark size={size} />
      {withName && (
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.02em" }}>Tandem</span>
      )}
    </span>
  );
}
