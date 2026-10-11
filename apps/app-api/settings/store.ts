/**
 * Postgres store for per-tenant hosted Settings (SPEC §5.12, §5.10).
 *
 * Both reads and the upsert run inside a `SET LOCAL ROLE samograph_app` +
 * `set_config('app.tenant_id', …)` transaction, so RLS — not just app-level
 * filtering — scopes every access to the caller's tenant (defence in depth,
 * §5.10). A superuser connection would BYPASS RLS and defeat the isolation.
 */
import type { SQL } from "bun";
import { setTenant } from "../../../packages/shared/db/client.ts";
import { DEFAULT_SETTINGS, fromRow, type TenantSettings } from "../../../packages/shared/settings/index.ts";

/** Encode a JS string[] as a Postgres array literal for a `text[]` column. */
function toPgTextArray(values: readonly string[]): string {
  const elems = values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`);
  return `{${elems.join(",")}}`;
}

interface SettingsRow {
  dictionary_preset: string;
  keyterms: string[] | null;
  language: string;
  chime: string;
}

/**
 * Read a tenant's settings, RLS-scoped. Returns the §5.12 {@link DEFAULT_SETTINGS}
 * (a fresh copy) when no row exists — a first GET never has to have written first.
 */
export async function readTenantSettings(sql: SQL, tenantId: string): Promise<TenantSettings> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE samograph_app");
    await setTenant(tx, tenantId);
    const rows = (await tx`
      SELECT dictionary_preset, keyterms, language, chime
        FROM settings
       WHERE tenant_id = ${tenantId}`) as unknown as SettingsRow[];
    return rows.length ? fromRow(rows[0]) : { ...DEFAULT_SETTINGS, keyterms: [] };
  });
}

/**
 * Upsert a tenant's settings, RLS-scoped. The RLS `WITH CHECK` makes a
 * cross-tenant write impossible even if `tenantId` were spoofed (§5.10). Returns
 * the stored document.
 */
export async function writeTenantSettings(
  sql: SQL,
  tenantId: string,
  value: TenantSettings,
): Promise<TenantSettings> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE samograph_app");
    await setTenant(tx, tenantId);
    const rows = (await tx`
      INSERT INTO settings (tenant_id, dictionary_preset, keyterms, language, chime, updated_at)
      VALUES (
        ${tenantId},
        ${value.dictionaryPreset},
        ${toPgTextArray(value.keyterms)}::text[],
        ${value.language},
        ${value.chime},
        now()
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        dictionary_preset = EXCLUDED.dictionary_preset,
        keyterms          = EXCLUDED.keyterms,
        language          = EXCLUDED.language,
        chime             = EXCLUDED.chime,
        updated_at        = now()
      RETURNING dictionary_preset, keyterms, language, chime`) as unknown as SettingsRow[];
    return fromRow(rows[0]);
  });
}
