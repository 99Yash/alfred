/**
 * Soft radial atmosphere behind the rail header. Two stacked gradients:
 * a warm amber sunrise near the top-right (under the weather chip) and a
 * cooler violet ambient near the top-left. Mirrors the landing's
 * `AuroraGlow` shape but is tuned tighter and softer because this is a
 * 340px rail, not a hero. Pointer-events-none, sits at z-0 under the
 * rail content.
 */
export function RailAtmosphere() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[320px] z-0 overflow-hidden"
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 70% at 78% 0%, rgba(251, 191, 36, 0.18) 0%, rgba(251, 191, 36, 0.05) 38%, transparent 68%)",
          filter: "blur(8px)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 65% at 18% 8%, rgba(167, 139, 250, 0.18) 0%, rgba(139, 92, 246, 0.04) 45%, transparent 70%)",
          filter: "blur(9px)",
        }}
      />
    </div>
  );
}
