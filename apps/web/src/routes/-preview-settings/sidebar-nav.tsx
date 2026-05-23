import { SECTIONS, type SectionId } from "./helpers";
import { SidebarRow } from "./sidebar-row";

export function SidebarNav({
  active,
  onChange,
}: {
  active: SectionId;
  onChange: (id: SectionId) => void;
}) {
  return (
    <aside aria-label="Settings sections" className="md:sticky md:top-16 self-start">
      <nav className="flex flex-col gap-0.5">
        {SECTIONS.map((s) => (
          <SidebarRow
            key={s.id}
            section={s}
            active={active === s.id}
            onClick={() => onChange(s.id)}
          />
        ))}
      </nav>
    </aside>
  );
}
