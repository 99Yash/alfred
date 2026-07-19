import { ArrowRight, Check } from "lucide-react";
import { useMemo, useState } from "react";
import { AllIntegrationsDialog } from "~/routes/-integrations/all-integrations-dialog";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { PROVIDER_BACKEND } from "~/lib/integrations/integrations";
import { useResolvedIntegrations } from "~/lib/integrations/use-integration-status";
import { cn } from "~/lib/utils";
import { Tip } from "./tip";

export function ConnectToolsBar() {
	// Opens the full-catalog dialog in place instead of routing to
	// /integrations, mirroring dimension's "Connect Your Tools" affordance.
	const [dialogOpen, setDialogOpen] = useState(false);
	// Drive the row off the real catalog overlaid with live credential state
	// instead of a hardcoded brand list. Catalog-only providers stay on the
	// integrations page, but this nudge only shows providers the user can
	// actually connect here.
	const integrations = useResolvedIntegrations();

	// Unconnected first (these are the actual nudge), connected trailing with
	// a check. Catalog order is preserved within each group.
	const ordered = useMemo(() => {
		const visible = integrations.filter(
			(p) => p.status === "connected" || PROVIDER_BACKEND[p.id] !== undefined,
		);
		const unconnected = visible.filter((p) => p.status !== "connected");
		const connected = visible.filter((p) => p.status === "connected");
		return { unconnected, connected, all: [...unconnected, ...connected] };
	}, [integrations]);

	// Everything actionable in this row is already connected, so drop the nudge.
	if (ordered.unconnected.length === 0) return null;

	return (
		<>
			<button
				type="button"
				onClick={() => setDialogOpen(true)}
				aria-label="Connect your tools"
				aria-haspopup="dialog"
				className={cn(
					// A quiet, borderless nudge sitting just below the composer — a
					// compact centered pill, not a card. The composer is the single
					// strong frosted surface; this reads as secondary to it rather than
					// a second stacked bordered shelf. Label left, tool marks right,
					// hover-reveal arrow trailing.
					"group relative mx-auto mt-3 flex w-fit items-center gap-2.5",
					"rounded-full px-3.5 py-2",
					// No rim, no shadow at rest — transparent. A soft frosted fill
					// materializes on hover/focus so feedback lives on the interaction,
					// and a slight press-scale answers pointer-down (Apple: respond on
					// press, keep it physical). transform/opacity only, so it composites.
					"bg-transparent transition-[background-color,transform] duration-300",
					"ease-[cubic-bezier(0.22,1,0.36,1)]",
					"hover:bg-app-bg-2/60 hover:backdrop-blur-sm",
					"focus-visible:bg-app-bg-2/60 focus-visible:backdrop-blur-sm",
					"active:scale-[0.98] motion-reduce:active:scale-100",
					"outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2/60",
					"focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
				)}
			>
				<span
					className={cn(
						"text-[13px] font-medium text-app-fg-2",
						"transition-colors duration-200 group-hover:text-app-fg-4",
					)}
				>
					Connect your tools
				</span>

				<div className="flex items-center">
					{/* On hover/focus the whole glyph cluster eases a touch to the right
					 * in concert with the arrow revealing — the row leans toward the
					 * action as one piece rather than the arrow arriving alone. Same
					 * 300ms curve as the arrow so they move together; transform-only so
					 * it composites, and `motion-reduce` holds it still. */}
					<span
						className={cn(
							"flex items-center transition-transform duration-300",
							"ease-[cubic-bezier(0.22,1,0.36,1)]",
							"group-hover:translate-x-1 group-focus-visible:translate-x-1",
							"motion-reduce:translate-x-0 motion-reduce:transition-none",
						)}
					>
						{/* Overlapping stack: each glyph sits on its own tile ringed in the
						 * page background, so a slight negative margin reads as a clean
						 * "cut-out" overlap rather than a collision. Connected tiles lift
						 * above their neighbours (z-10) so their check badge stays visible;
						 * the hovered tile floats above everything (z-20). */}
						{ordered.all.map((p, i) => {
							const connected = p.status === "connected";
							return (
								<Tip
									key={p.id}
									label={connected ? `${p.name} — connected` : p.name}
								>
									<span
										className={cn(
											"relative grid size-[22px] shrink-0 place-items-center rounded-full",
											"bg-app-bg-2 ring-2 ring-app-background",
											i > 0 && "-ml-1.5",
											"transition-transform duration-200 ease-out hover:z-20 hover:scale-110",
											connected ? "z-10" : "",
										)}
									>
										<span className="sr-only">
											{connected ? `${p.name}, connected` : p.name}
										</span>
										<IntegrationGlyph
											brand={p.brand}
											size={14}
											className={cn(
												"transition-opacity duration-200",
												connected
													? "opacity-100"
													: "opacity-70 group-hover:opacity-100",
											)}
										/>
										{connected ? (
											<span
												aria-hidden
												className={cn(
													"absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center",
													"rounded-full bg-emerald-400 text-black",
													"ring-2 ring-app-background",
												)}
											>
												<Check size={7} strokeWidth={3.5} />
											</span>
										) : null}
									</span>
								</Tip>
							);
						})}
					</span>

					{/* Hover-reveal arrow — its slot is always reserved so the centered
					 * pill never reflows; the glyph itself fades and slides in from the
					 * left on hover/focus (Apple: continuous, no layout jump). CSS-only;
					 * `motion-reduce` snaps it in without the slide. */}
					<span
						aria-hidden
						className={cn(
							"ml-1.5 flex w-3 items-center justify-center text-app-fg-3",
							"-translate-x-1 opacity-0 transition-[transform,opacity] duration-300",
							"ease-[cubic-bezier(0.22,1,0.36,1)]",
							"group-hover:translate-x-0 group-hover:opacity-100",
							"group-focus-visible:translate-x-0 group-focus-visible:opacity-100",
							"motion-reduce:translate-x-0 motion-reduce:transition-none",
						)}
					>
						<ArrowRight className="size-3 shrink-0" strokeWidth={2.25} />
					</span>
				</div>
			</button>
			<AllIntegrationsDialog open={dialogOpen} onOpenChange={setDialogOpen} />
		</>
	);
}
