-- ADR-0130 amendment (c): `action_stagings.approval_cause` keeps the reason of a card, not a
-- stored list of settings. The web and the model derive the settings from current policy.
-- Convert each old `{cause, settings}` value. A `high_risk` card names only the tool. Any other
-- card names its governing integration and the setting that supplied the mode. An old value
-- that listed "Always allow" and no integration mode came from a tool override.
-- An old value does not record that the global default supplied the mode, so `source: 'default'`
-- cannot be recovered: such a row becomes `integration`. The model fact of an old row can name
-- the wrong setting source. The derived settings do not read `source`, so the links stay right.
UPDATE "action_stagings"
SET "approval_cause" = CASE
  WHEN "approval_cause"->>'cause' = 'high_risk' THEN
    jsonb_build_object('cause', 'high_risk', 'toolName', "tool_name")
  ELSE
    jsonb_build_object(
      'cause', "approval_cause"->>'cause',
      'toolName', "tool_name",
      'integration', "integration",
      'source', CASE
        WHEN jsonb_path_exists("approval_cause", '$.settings[*] ? (@.kind == "always_allow")')
          AND NOT jsonb_path_exists("approval_cause", '$.settings[*] ? (@.kind == "integration_mode")')
          THEN 'tool_override'
        ELSE 'integration'
      END
    )
END
WHERE "approval_cause" ? 'settings';
