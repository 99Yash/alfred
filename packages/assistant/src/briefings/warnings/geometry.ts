import { assertNever } from "@alfred/contracts";
import { z } from "zod";

/** A GeoJSON position: longitude, then latitude. Extra members (altitude) are allowed. */
const positionSchema = z.array(z.number()).min(2);

/** A ring of positions. GeoJSON closes it by repeating the first position. */
const ringSchema = z.array(positionSchema);

const polygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(ringSchema),
});

const multiPolygonSchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(ringSchema)),
});

/** An area geometry. A point or a line has no inside, so it is not an area. */
export const areaGeometrySchema = z.discriminatedUnion("type", [polygonSchema, multiPolygonSchema]);

export type AreaGeometry = z.infer<typeof areaGeometrySchema>;

/**
 * Whether the point is inside the area (ADR-0117 decision 4). The test is even-odd over every ring
 * of a polygon, so a hole (an inner ring) is outside. A point exactly on an edge can fall on
 * either side. The plane test is correct for an area that does not cross the antimeridian or a
 * pole, which holds for the feeds that the briefing reads today.
 */
export function containsPoint(area: AreaGeometry, lng: number, lat: number): boolean {
  switch (area.type) {
    case "Polygon":
      return insideRings(area.coordinates, lng, lat);
    case "MultiPolygon":
      return area.coordinates.some((rings) => insideRings(rings, lng, lat));
    default:
      return assertNever(area, "area geometry");
  }
}

function insideRings(rings: readonly (readonly (readonly number[])[])[], x: number, y: number) {
  let inside = false;

  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi = 0, yi = 0] = ring[i] ?? [];
      const [xj = 0, yj = 0] = ring[j] ?? [];

      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }

  return inside;
}

/** Great-circle distance in kilometres. */
export function distanceKm(
  a: { readonly lat: number; readonly lng: number },
  b: { readonly lat: number; readonly lng: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const EARTH_RADIUS_KM = 6371;
