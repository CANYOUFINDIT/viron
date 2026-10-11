/** Portable schema: LONGTEXT/VARCHAR/INTEGER work with SQLite and MySQL. */
export const ORGANIZATION_RBAC_SCHEMA = `
CREATE TABLE IF NOT EXISTS organization_roles (
 id VARCHAR(64) PRIMARY KEY, organization_id VARCHAR(64) NOT NULL,
 name VARCHAR(160) NOT NULL, description TEXT NOT NULL, permission_codes_json LONGTEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
 created_at VARCHAR(40) NOT NULL, updated_at VARCHAR(40) NOT NULL,
 UNIQUE(organization_id, name), FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS organization_role_assignments (
 id VARCHAR(64) PRIMARY KEY, organization_id VARCHAR(64) NOT NULL, role_id VARCHAR(64) NOT NULL,
 subject_type VARCHAR(16) NOT NULL, subject_id VARCHAR(64) NOT NULL, management_scope_json LONGTEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, starts_at VARCHAR(40), expires_at VARCHAR(40), reason TEXT NOT NULL,
 source VARCHAR(16) NOT NULL, legacy_id VARCHAR(160), created_at VARCHAR(40) NOT NULL,
 UNIQUE(organization_id, legacy_id), FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
 FOREIGN KEY(role_id) REFERENCES organization_roles(id)
);
CREATE TABLE IF NOT EXISTS organization_role_data_grants (
 id VARCHAR(64) PRIMARY KEY, organization_id VARCHAR(64) NOT NULL, role_id VARCHAR(64) NOT NULL,
 target_type VARCHAR(32) NOT NULL, target_id VARCHAR(64) NOT NULL, batch_id VARCHAR(64) NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, starts_at VARCHAR(40), expires_at VARCHAR(40), reason TEXT NOT NULL,
 source VARCHAR(16) NOT NULL, legacy_id VARCHAR(200), request_id VARCHAR(64), created_at VARCHAR(40) NOT NULL,
 UNIQUE(organization_id, legacy_id), FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
 FOREIGN KEY(role_id) REFERENCES organization_roles(id)
);
CREATE TABLE IF NOT EXISTS organization_feature_grants (
 id VARCHAR(64) PRIMARY KEY, organization_id VARCHAR(64) NOT NULL,
 subject_type VARCHAR(16) NOT NULL, subject_id VARCHAR(64) NOT NULL,
 targets_json LONGTEXT NOT NULL, features_json LONGTEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, starts_at VARCHAR(40), expires_at VARCHAR(40), reason TEXT NOT NULL,
 request_id VARCHAR(64), created_at VARCHAR(40) NOT NULL,
 FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS organization_role_events (
 id VARCHAR(64) PRIMARY KEY, organization_id VARCHAR(64) NOT NULL,
 actor_id VARCHAR(64), actor_name VARCHAR(160) NOT NULL, action VARCHAR(80) NOT NULL,
 reason TEXT NOT NULL, before_json LONGTEXT, after_json LONGTEXT, created_at VARCHAR(40) NOT NULL,
 FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS organization_role_mutations (
 organization_id VARCHAR(64) NOT NULL, actor_id VARCHAR(64) NOT NULL,
 mutation_key VARCHAR(64) NOT NULL, request_hash VARCHAR(64) NOT NULL,
 response_json LONGTEXT NOT NULL, created_at VARCHAR(40) NOT NULL,
 PRIMARY KEY(organization_id, actor_id, mutation_key),
 FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS organization_role_migrations (
 organization_id VARCHAR(64) PRIMARY KEY, version INTEGER NOT NULL, completed_at VARCHAR(40) NOT NULL,
 FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);
`;

export const MYSQL_ORGANIZATION_RBAC_SCHEMA = ORGANIZATION_RBAC_SCHEMA.replace(
  /\);/g,
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
);
