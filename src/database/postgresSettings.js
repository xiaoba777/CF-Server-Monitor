// PostgreSQL 16's input validation lets old plain-text/malformed settings survive
// migration. Keep casts inside CASE; boolean AND does not guarantee evaluation order.
export const SETTINGS_JSON_OBJECT = `CASE
  WHEN pg_input_is_valid(settings.value, 'jsonb') THEN
    CASE WHEN jsonb_typeof(settings.value::jsonb) = 'object'
      THEN settings.value::jsonb ELSE '{}'::jsonb END
  ELSE '{}'::jsonb END`;

export async function savePostgresJwtSecret(database, secret, minimumLength) {
  const row = await database.prepare(`
    INSERT INTO settings (key, value)
    VALUES ('site_options', jsonb_build_object('jwt_secret', ?::text)::text)
    ON CONFLICT (key) DO UPDATE SET value = (CASE
      WHEN jsonb_typeof((${SETTINGS_JSON_OBJECT})->'jwt_secret') = 'string'
        AND length((${SETTINGS_JSON_OBJECT})->>'jwt_secret') >= ?
      THEN ${SETTINGS_JSON_OBJECT}
      ELSE (${SETTINGS_JSON_OBJECT}) || jsonb_build_object('jwt_secret', ?::text)
    END)::text
    RETURNING value
  `).bind(secret, minimumLength, secret).first();
  return JSON.parse(row.value).jwt_secret;
}

export async function savePostgresThemeOptions(database, themeOptions) {
  const serialized = JSON.stringify(themeOptions);
  await database.prepare(`
    INSERT INTO settings (key, value)
    VALUES ('appearance_options', jsonb_build_object('theme_options', ?::jsonb)::text)
    ON CONFLICT (key) DO UPDATE SET value =
      ((${SETTINGS_JSON_OBJECT}) || jsonb_build_object('theme_options', ?::jsonb))::text
  `).bind(serialized, serialized).run();
}
