export function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <p className="text-xs text-vs-fg-3">{label}</p>
      <p className="min-w-0 truncate text-right text-xs font-medium text-vs-fg-4">{value}</p>
    </div>
  );
}
