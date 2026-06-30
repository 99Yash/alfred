CREATE VIEW "public"."active_entity_co_occurrence" AS (
  SELECT
    eco.id,
    eco.user_id,
    eco.projection_name,
    eco.projection_version,
    eco.projection_run_id,
    eco.a_entity_id,
    eco.b_entity_id,
    eco.weight,
    eco.count,
    eco.family_count,
    eco.last_seen_at,
    eco.created_at,
    eco.updated_at
  FROM entity_co_occurrence eco
  INNER JOIN active_projection_versions apv
    ON apv.user_id = eco.user_id
   AND apv.projection_name = eco.projection_name
   AND apv.active_version = eco.projection_version
   AND apv.active_run_id = eco.projection_run_id
);--> statement-breakpoint
CREATE VIEW "public"."active_entity_edges" AS (
  SELECT
    ee.id,
    ee.user_id,
    ee.projection_name,
    ee.projection_version,
    ee.projection_run_id,
    ee.from_entity_id,
    ee.to_entity_id,
    ee.relation_type,
    ee.weight,
    ee.confidence,
    ee.provenance,
    ee.valid_from,
    ee.valid_until,
    ee.created_at,
    ee.updated_at
  FROM entity_edges ee
  INNER JOIN active_projection_versions apv
    ON apv.user_id = ee.user_id
   AND apv.projection_name = ee.projection_name
   AND apv.active_version = ee.projection_version
   AND apv.active_run_id = ee.projection_run_id
);--> statement-breakpoint
CREATE VIEW "public"."active_entity_profiles" AS (
  SELECT
    ep.id,
    ep.user_id,
    ep.projection_name,
    ep.projection_version,
    ep.projection_run_id,
    ep.entity_id,
    ep.display_name,
    ep.kind,
    ep.significance_components,
    ep.last_seen_at,
    ep.provenance,
    ep.computed_at,
    ep.created_at,
    ep.updated_at
  FROM entity_profiles ep
  INNER JOIN active_projection_versions apv
    ON apv.user_id = ep.user_id
   AND apv.projection_name = ep.projection_name
   AND apv.active_version = ep.projection_version
   AND apv.active_run_id = ep.projection_run_id
);