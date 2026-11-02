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

/** A point on the earth, in degrees. */
type GeoPoint = { readonly lat: number; readonly lng: number };

/** The rings of one polygon: the shell first, then its holes. */
type PolygonRings = z.infer<typeof polygonSchema>["coordinates"];

/**
 * Whether the point is inside the area (ADR-0117 decision 4). The test is even-odd over every ring
 * of a polygon, so a hole (an inner ring) is outside. A point exactly on an edge can fall on
 * either side.
 *
 * GDACS is a global feed, so a polygon can cross the antimeridian (a Pacific cyclone near Fiji).
 * If an edge of a polygon spans more than 180 degrees of longitude, the polygon crosses it: the
 * test adds 360 to each negative longitude of every ring, shell and holes alike, so that the
 * polygon is one continuous range. A ring with longitudes past +180 or -180 needs no change. In
 * both cases, the test checks the point at `lng`, `lng + 360`, and `lng - 360`. A ring that goes
 * around a pole, or that is wider than 180 degrees of longitude, is out of scope and can give a
 * wrong answer.
 */
export function containsPoint(area: AreaGeometry, point: GeoPoint): boolean {
  switch (area.type) {
    case "Polygon":
      return insidePolygon(area.coordinates, point);
    case "MultiPolygon":
      return area.coordinates.some((rings) => insidePolygon(rings, point));
    default:
      return assertNever(area, "area geometry");
  }
}

function insidePolygon(rings: PolygonRings, { lat, lng }: GeoPoint): boolean {
  const crosses = rings.some((ring) =>
    ring.some(([x = 0], i) => i > 0 && Math.abs(x - (ring[i - 1]?.[0] ?? x)) > 180),
  );

  const unwrap = crosses ? (x: number) => (x < 0 ? x + 360 : x) : (x: number) => x;

  return [lng, lng + 360, lng - 360].some((x) => insideRings(rings, unwrap, x, lat));
}

function insideRings(rings: PolygonRings, unwrap: (lng: number) => number, x: number, y: number) {
  let inside = false;

  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [lngI = 0, yi = 0] = ring[i] ?? [];
      const [lngJ = 0, yj = 0] = ring[j] ?? [];
      const xi = unwrap(lngI);
      const xj = unwrap(lngJ);

      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }

  return inside;
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const EARTH_RADIUS_KM = 6371;
