export function Divider() {
  return (
    <div className="flex items-center gap-3 text-[11px] text-vs-fg-2">
      <span className="h-px flex-1 bg-vs-bg-a2" aria-hidden />
      <span>or</span>
      <span className="h-px flex-1 bg-vs-bg-a2" aria-hidden />
    </div>
  );
}
