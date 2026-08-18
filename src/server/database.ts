import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import argon2 from "argon2";
import Database from "better-sqlite3";
import type { AppConfig } from "./config.js";
import { MysqlDatabaseClient, SqliteDatabaseClient, type EnvmanDatabase } from "./database-client.js";
import { MYSQL_SCHEMA } from "./mysql-schema.js";
import { passwordPolicyError } from "./password-policy.js";
import { refreshPendingExistingConnections } from "./connection-existing.js";

export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_idx ON admin_users(username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_type TEXT NOT NULL CHECK(key_type IN ('platform','personal')),
  user_id TEXT REFERENCES admin_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  mcp_approval_mode TEXT NOT NULL DEFAULT 'always',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK((key_type = 'platform' AND user_id IS NULL) OR (key_type = 'personal' AND user_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON api_keys(key_type, user_id, status, created_at);

CREATE TABLE IF NOT EXISTS api_key_login_tickets (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  workspace_type TEXT NOT NULL CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL,
  redirect_path TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS api_key_login_tickets_expiry_idx ON api_key_login_tickets(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_name_idx ON organizations(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS organization_members_user_idx ON organization_members(user_id, organization_id);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL REFERENCES admin_users(id),
  expires_at TEXT NOT NULL,
  accepted_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS organization_invitations_organization_idx
  ON organization_invitations(organization_id, created_at);

CREATE TABLE IF NOT EXISTS organization_invitation_policies (
  invitation_id TEXT PRIMARY KEY REFERENCES organization_invitations(id) ON DELETE CASCADE,
  token_ciphertext TEXT,
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0),
  revoked_at TEXT,
  deleted_at TEXT,
  project_id TEXT
);

CREATE TABLE IF NOT EXISTS organization_invitation_acceptances (
  invitation_id TEXT NOT NULL REFERENCES organization_invitations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  accepted_at TEXT NOT NULL,
  joined_organization INTEGER NOT NULL DEFAULT 0 CHECK(joined_organization IN (0,1)),
  joined_project INTEGER NOT NULL DEFAULT 0 CHECK(joined_project IN (0,1)),
  PRIMARY KEY(invitation_id, user_id)
);

CREATE INDEX IF NOT EXISTS organization_invitation_acceptances_user_idx
  ON organization_invitation_acceptances(user_id, accepted_at);

CREATE TABLE IF NOT EXISTS organization_member_invitations (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL REFERENCES organization_invitations(id) ON DELETE CASCADE,
  invited_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(organization_id, user_id),
  FOREIGN KEY(organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS organization_member_invitations_invitation_idx
  ON organization_member_invitations(invitation_id, accepted_at);
CREATE INDEX IF NOT EXISTS organization_member_invitations_inviter_idx
  ON organization_member_invitations(invited_by_user_id, accepted_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_organization_name_idx ON projects(organization_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS projects_parent_idx ON projects(organization_id, parent_id, name);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id, project_id);

CREATE TABLE IF NOT EXISTS resource_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL CHECK(grantee_type IN ('user','project')),
  grantee_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('environment_group','environment','ssh_connection','database_connection','redis_connection')),
  resource_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, grantee_type, grantee_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS resource_grants_grantee_idx
  ON resource_grants(organization_id, grantee_type, grantee_id);
CREATE INDEX IF NOT EXISTS resource_grants_resource_idx
  ON resource_grants(organization_id, resource_type, resource_id);

CREATE TABLE IF NOT EXISTS environment_groups (
  id TEXT PRIMARY KEY,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#1d8a74',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  group_id TEXT REFERENCES environment_groups(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','maintenance','error','disabled')),
  owner TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS environments_group_idx ON environments(group_id);
CREATE INDEX IF NOT EXISTS environments_status_idx ON environments(status);

CREATE TABLE IF NOT EXISTS environment_preferences (
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  alias_name TEXT NOT NULL DEFAULT '',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id, environment_id)
);

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id TEXT PRIMARY KEY,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  parent_key TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK(type IN ('folder','document')),
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_type, workspace_id, parent_key, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS knowledge_node_environments (
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  assigned_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY(node_id, environment_id)
);

CREATE INDEX IF NOT EXISTS knowledge_node_environments_environment_idx
  ON knowledge_node_environments(environment_id, node_id);

CREATE TABLE IF NOT EXISTS knowledge_node_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL CHECK(grantee_type IN ('user','project')),
  grantee_id TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, node_id, grantee_type, grantee_id)
);

CREATE INDEX IF NOT EXISTS knowledge_node_grants_grantee_idx
  ON knowledge_node_grants(organization_id, grantee_type, grantee_id);
CREATE INDEX IF NOT EXISTS knowledge_node_grants_node_idx
  ON knowledge_node_grants(node_id, created_at);

CREATE TABLE IF NOT EXISTS knowledge_assets (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS knowledge_assets_document_idx
  ON knowledge_assets(document_id, created_at);

CREATE TABLE IF NOT EXISTS web_entries (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_credentials (
  id TEXT PRIMARY KEY,
  web_entry_id TEXT NOT NULL REFERENCES web_entries(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  custom_fields_json TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS desktop_devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  public_key_pem TEXT NOT NULL,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS desktop_devices_user_idx ON desktop_devices(user_id, status);

CREATE TABLE IF NOT EXISTS desktop_operation_reports (
  operation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS desktop_operation_reports_expiry_idx ON desktop_operation_reports(expires_at);

CREATE TABLE IF NOT EXISTS desktop_device_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  key_id TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS desktop_device_challenges_expiry_idx ON desktop_device_challenges(expires_at);

CREATE TABLE IF NOT EXISTS desktop_credential_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES web_credentials(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS desktop_credential_requests_expiry_idx ON desktop_credential_requests(expires_at);

CREATE TABLE IF NOT EXISTS web_account_views (
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES web_credentials(id) ON DELETE CASCADE,
  last_url TEXT NOT NULL DEFAULT '',
  last_title TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id, credential_id)
);

CREATE INDEX IF NOT EXISTS web_account_views_updated_idx
  ON web_account_views(updated_at DESC);

CREATE TABLE IF NOT EXISTS connection_sources (
  id TEXT PRIMARY KEY,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config_ciphertext TEXT NOT NULL,
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  schedule_expression TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connection_source_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES connection_sources(id) ON DELETE CASCADE,
  workspace_type TEXT NOT NULL CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL,
  triggered_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual','schedule')),
  status TEXT NOT NULL CHECK(status IN ('running','success','failed')),
  conflict_strategy TEXT NOT NULL CHECK(conflict_strategy IN ('overwrite','ignore')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  items_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS connection_source_runs_source_idx
  ON connection_source_runs(source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS connection_source_runs_workspace_idx
  ON connection_source_runs(workspace_type, workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS connection_groups (
  id TEXT PRIMARY KEY,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK(type IN ('ssh','database','redis')),
  parent_id TEXT REFERENCES connection_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS connection_groups_parent_idx ON connection_groups(type, parent_id, sort_order, name);

CREATE TABLE IF NOT EXISTS ssh_keys (
  id TEXT PRIMARY KEY,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  private_key_ciphertext TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES admin_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ssh_keys_workspace_name_idx
  ON ssh_keys(workspace_type, workspace_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS ssh_keys_workspace_fingerprint_idx
  ON ssh_keys(workspace_type, workspace_id, fingerprint);

CREATE TABLE IF NOT EXISTS ssh_connections (
  id TEXT PRIMARY KEY,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  connection_group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES connection_sources(id) ON DELETE SET NULL,
  source_item_id TEXT,
  source_path TEXT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password',
  ssh_key_id TEXT REFERENCES ssh_keys(id) ON DELETE SET NULL,
  credential_ciphertext TEXT NOT NULL,
  jump_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, source_item_id)
);

CREATE TABLE IF NOT EXISTS ssh_connection_environments (
  connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  maintenance_sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(connection_id, environment_id)
);

CREATE INDEX IF NOT EXISTS ssh_connection_environments_environment_idx
  ON ssh_connection_environments(environment_id, connection_id);

CREATE TABLE IF NOT EXISTS desktop_ssh_credential_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS desktop_ssh_credential_requests_expiry_idx ON desktop_ssh_credential_requests(expires_at);

CREATE TABLE IF NOT EXISTS environment_logs (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  ssh_connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_paths_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(environment_id, ssh_connection_id, file_path)
);

CREATE INDEX IF NOT EXISTS environment_logs_environment_idx
  ON environment_logs(environment_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(environment_id, name COLLATE NOCASE)
);

CREATE INDEX IF NOT EXISTS services_environment_idx ON services(environment_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS service_deployments (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  ssh_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
  ssh_connection_name TEXT NOT NULL DEFAULT '',
  provider_type TEXT NOT NULL CHECK(provider_type IN ('systemd','docker','podman','supervisor','kubernetes','process')),
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('discovered','manual')),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('running','stopped','degraded','unknown','disabled')),
  state_detail TEXT NOT NULL DEFAULT '',
  latest_metrics_json TEXT NOT NULL DEFAULT '{}',
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS service_deployments_target_idx
  ON service_deployments(service_id, ssh_connection_id, provider_type, external_id);
CREATE INDEX IF NOT EXISTS service_deployments_connection_idx
  ON service_deployments(ssh_connection_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS service_log_links (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  environment_log_id TEXT NOT NULL REFERENCES environment_logs(id) ON DELETE CASCADE,
  PRIMARY KEY(service_id, environment_log_id)
);

CREATE TABLE IF NOT EXISTS service_script_actions (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  deployment_id TEXT REFERENCES service_deployments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'terminal',
  script_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS service_script_actions_service_idx
  ON service_script_actions(service_id, deployment_id, created_at);

CREATE TABLE IF NOT EXISTS monitor_hosts (
  ssh_connection_id TEXT PRIMARY KEY REFERENCES ssh_connections(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL DEFAULT '',
  agent_version TEXT NOT NULL DEFAULT '',
  protocol_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('ready','missing','error','unknown')),
  last_sequence INTEGER NOT NULL DEFAULT 0,
  latest_host_json TEXT NOT NULL DEFAULT '{}',
  latest_candidates_json TEXT NOT NULL DEFAULT '[]',
  latest_kubernetes_configs_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT NOT NULL DEFAULT '',
  last_collected_at TEXT,
  last_pulled_at TEXT,
  install_path TEXT NOT NULL DEFAULT '',
  install_architecture TEXT NOT NULL DEFAULT '',
  install_managed INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_samples (
  ssh_connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  sequence_start INTEGER NOT NULL,
  sequence_end INTEGER NOT NULL,
  collected_at TEXT NOT NULL,
  resolution_seconds INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(ssh_connection_id, agent_id, sequence_end)
);

CREATE INDEX IF NOT EXISTS monitor_samples_collected_idx
  ON monitor_samples(ssh_connection_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS monitor_samples_agent_collected_idx
  ON monitor_samples(agent_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS monitor_sequence_gaps (
  ssh_connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  sequence_start INTEGER NOT NULL,
  sequence_end INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(ssh_connection_id, agent_id, sequence_end)
);

CREATE TABLE IF NOT EXISTS monitor_install_tasks (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  ssh_connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  connection_name TEXT NOT NULL,
  install_path TEXT NOT NULL,
  actor_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error')),
  phase TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  current_message TEXT NOT NULL DEFAULT '',
  logs_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS monitor_install_tasks_connection_idx
  ON monitor_install_tasks(ssh_connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS monitor_alert_settings (
  environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  host_offline_enabled INTEGER NOT NULL DEFAULT 0,
  cpu_enabled INTEGER NOT NULL DEFAULT 1,
  cpu_threshold REAL NOT NULL DEFAULT 90,
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  memory_threshold REAL NOT NULL DEFAULT 90,
  disk_usage_enabled INTEGER NOT NULL DEFAULT 1,
  disk_usage_threshold REAL NOT NULL DEFAULT 90,
  temperature_enabled INTEGER NOT NULL DEFAULT 1,
  temperature_threshold REAL NOT NULL DEFAULT 80,
  deployment_status_enabled INTEGER NOT NULL DEFAULT 1,
  disk_missing_enabled INTEGER NOT NULL DEFAULT 1,
  excluded_disks_json TEXT NOT NULL DEFAULT '[]',
  updated_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_alert_states (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('host','deployment')),
  target_id TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK(rule_type IN ('host_offline','cpu','memory','disk_usage','temperature','disk_added','disk_missing','deployment_status')),
  rule_key_hash TEXT NOT NULL,
  rule_key TEXT NOT NULL DEFAULT '',
  ssh_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  deployment_id TEXT REFERENCES service_deployments(id) ON DELETE SET NULL,
  target_name TEXT NOT NULL DEFAULT '',
  connection_name TEXT NOT NULL DEFAULT '',
  service_name TEXT NOT NULL DEFAULT '',
  breach_count INTEGER NOT NULL DEFAULT 0,
  recovery_count INTEGER NOT NULL DEFAULT 0,
  active_alert_id TEXT,
  last_value_json TEXT NOT NULL DEFAULT '{}',
  last_evaluated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(environment_id, target_type, target_id, rule_type, rule_key_hash)
);

CREATE INDEX IF NOT EXISTS monitor_alert_states_environment_idx
  ON monitor_alert_states(environment_id, active_alert_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS monitor_alerts (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  state_id TEXT REFERENCES monitor_alert_states(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('host','deployment')),
  target_id TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK(rule_type IN ('host_offline','cpu','memory','disk_usage','temperature','disk_added','disk_missing','deployment_status')),
  rule_key TEXT NOT NULL DEFAULT '',
  ssh_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  deployment_id TEXT REFERENCES service_deployments(id) ON DELETE SET NULL,
  environment_name TEXT NOT NULL,
  target_name TEXT NOT NULL DEFAULT '',
  connection_name TEXT NOT NULL DEFAULT '',
  service_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('active','recovered','event')),
  details_json TEXT NOT NULL DEFAULT '{}',
  triggered_at TEXT NOT NULL,
  recovered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS monitor_alerts_environment_idx
  ON monitor_alerts(environment_id, status, triggered_at DESC);

CREATE TABLE IF NOT EXISTS monitor_alert_user_states (
  alert_id TEXT NOT NULL REFERENCES monitor_alerts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  active_notified_at TEXT,
  recovery_notified_at TEXT,
  read_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(alert_id, user_id)
);

CREATE INDEX IF NOT EXISTS monitor_alert_user_states_user_idx
  ON monitor_alert_user_states(user_id, read_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS database_connections (
  id TEXT PRIMARY KEY,
  profile_parent_id TEXT REFERENCES database_connections(id) ON DELETE CASCADE,
  profile_name TEXT NOT NULL DEFAULT '',
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  connection_group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES connection_sources(id) ON DELETE SET NULL,
  source_item_id TEXT,
  source_path TEXT,
  name TEXT NOT NULL,
  engine TEXT NOT NULL CHECK(engine IN ('mysql','mariadb')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  default_database TEXT NOT NULL DEFAULT '',
  connection_mode TEXT NOT NULL DEFAULT 'tcp',
  options_json TEXT NOT NULL DEFAULT '{}',
  source_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, source_item_id)
);

CREATE TABLE IF NOT EXISTS desktop_database_credential_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS desktop_database_credential_requests_expiry_idx
  ON desktop_database_credential_requests(expires_at);

CREATE TABLE IF NOT EXISTS database_connection_environments (
  connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  PRIMARY KEY(connection_id, environment_id)
);

CREATE INDEX IF NOT EXISTS database_connection_environments_environment_idx
  ON database_connection_environments(environment_id, connection_id);

CREATE TABLE IF NOT EXISTS redis_connections (
  id TEXT PRIMARY KEY,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  connection_group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES connection_sources(id) ON DELETE SET NULL,
  source_item_id TEXT,
  source_path TEXT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 6379,
  username TEXT NOT NULL DEFAULT '',
  credential_ciphertext TEXT NOT NULL,
  default_database INTEGER NOT NULL DEFAULT 0,
  connection_mode TEXT NOT NULL DEFAULT 'tcp' CHECK(connection_mode IN ('tcp','sshTunnel')),
  options_json TEXT NOT NULL DEFAULT '{}',
  source_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, source_item_id)
);

CREATE TABLE IF NOT EXISTS desktop_redis_credential_requests (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES redis_connections(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS desktop_redis_credential_requests_expiry_idx ON desktop_redis_credential_requests(expires_at);

CREATE TABLE IF NOT EXISTS redis_connection_environments (
  connection_id TEXT NOT NULL REFERENCES redis_connections(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  PRIMARY KEY(connection_id, environment_id)
);

CREATE INDEX IF NOT EXISTS redis_connection_environments_environment_idx
  ON redis_connection_environments(environment_id, connection_id);

CREATE TABLE IF NOT EXISTS source_folder_mappings (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES connection_sources(id) ON DELETE CASCADE,
  source_path_prefix TEXT NOT NULL,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE(source_id, source_path_prefix)
);

CREATE TABLE IF NOT EXISTS database_query_history (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES admin_users(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES database_connections(id) ON DELETE SET NULL,
  database_name TEXT NOT NULL DEFAULT '',
  sql_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','error','cancelled')),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS database_query_history_connection_idx
  ON database_query_history(connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS database_query_favorites (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES admin_users(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES database_connections(id) ON DELETE CASCADE,
  database_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS database_query_favorites_connection_idx
  ON database_query_favorites(connection_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS database_saved_queries (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  database_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  sql_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  UNIQUE(owner_user_id, connection_id, database_name, name)
);

CREATE INDEX IF NOT EXISTS database_saved_queries_connection_idx
  ON database_saved_queries(connection_id, database_name, name);

CREATE TABLE IF NOT EXISTS database_table_profiles (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  database_name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  UNIQUE(owner_user_id, connection_id, database_name, table_name, name)
);

CREATE INDEX IF NOT EXISTS database_table_profiles_connection_idx
  ON database_table_profiles(connection_id, database_name, table_name, name);

CREATE TABLE IF NOT EXISTS database_automation_jobs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  database_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  works_json TEXT NOT NULL DEFAULT '[]',
  advanced_json TEXT NOT NULL DEFAULT '{}',
  schedule_cron TEXT NOT NULL DEFAULT '',
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','success','error')),
  logs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  last_run_at TEXT,
  UNIQUE(owner_user_id, workspace_type, workspace_id, name)
);

CREATE INDEX IF NOT EXISTS database_automation_jobs_connection_idx
  ON database_automation_jobs(connection_id, database_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS database_models (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  connection_id TEXT REFERENCES database_connections(id) ON DELETE SET NULL,
  database_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK(model_type IN ('physical','logical','conceptual')),
  database_engine TEXT NOT NULL DEFAULT 'MySQL',
  database_version TEXT NOT NULL DEFAULT '8.1',
  model_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  UNIQUE(owner_user_id, workspace_type, workspace_id, name)
);

CREATE INDEX IF NOT EXISTS database_models_connection_idx
  ON database_models(connection_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS database_code_snippets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sql_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, workspace_type, workspace_id, name)
);

CREATE TABLE IF NOT EXISTS database_bi_workspaces (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  connection_id TEXT REFERENCES database_connections(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  document_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  UNIQUE(owner_user_id, workspace_type, workspace_id, name)
);

CREATE INDEX IF NOT EXISTS database_bi_workspaces_connection_idx
  ON database_bi_workspaces(connection_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS database_object_groups (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  database_name TEXT NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, connection_id, database_name, category, name)
);

CREATE TABLE IF NOT EXISTS database_object_group_members (
  group_id TEXT NOT NULL REFERENCES database_object_groups(id) ON DELETE CASCADE,
  object_name TEXT NOT NULL,
  object_source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY(group_id, object_name, object_source)
);

CREATE TABLE IF NOT EXISTS database_object_favorites (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('database','table')),
  database_name TEXT NOT NULL,
  table_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, connection_id, target_type, database_name, table_name)
);

CREATE INDEX IF NOT EXISTS database_object_favorites_owner_idx
  ON database_object_favorites(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS database_connection_preferences (
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE,
  starred INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id, connection_id)
);

CREATE TABLE IF NOT EXISTS ssh_command_favorites (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES ssh_connections(id) ON DELETE CASCADE,
  command_text TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, connection_id, command_hash)
);

CREATE INDEX IF NOT EXISTS ssh_command_favorites_connection_idx
  ON ssh_command_favorites(owner_user_id, connection_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS connection_inspection_results (
  connection_type TEXT NOT NULL CHECK(connection_type IN ('ssh','database','redis')),
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available','unavailable')),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  checked_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(connection_type, connection_id)
);

CREATE INDEX IF NOT EXISTS connection_inspection_results_checked_idx
  ON connection_inspection_results(checked_at DESC);

CREATE TABLE IF NOT EXISTS connection_import_batches (
  id TEXT PRIMARY KEY,
  workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL REFERENCES connection_sources(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('securecrt','navicat')),
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('preview','imported','cancelled')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS connection_import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES connection_import_batches(id) ON DELETE CASCADE,
  connection_type TEXT NOT NULL CHECK(connection_type IN ('ssh','database')),
  source_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('new','conflict','invalid','imported','skipped')),
  conflict_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_connection_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS connection_import_items_batch_idx
  ON connection_import_items(batch_id, status);

CREATE TABLE IF NOT EXISTS database_tasks (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES admin_users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('backup','restore','transfer','import')),
  connection_id TEXT REFERENCES database_connections(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error','cancelled')),
  progress INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  logs_json TEXT NOT NULL DEFAULT '[]',
  output_path TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS database_tasks_created_idx ON database_tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS ssh_terminal_recordings (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES admin_users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
  connection_name TEXT NOT NULL,
  host TEXT NOT NULL,
  recording_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('recording','completed','interrupted')),
  size_bytes INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  close_reason TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS ssh_terminal_recordings_started_idx
  ON ssh_terminal_recordings(started_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  workspace_type TEXT CHECK(workspace_type IN ('personal','organization')),
  workspace_id TEXT,
  source TEXT NOT NULL DEFAULT 'unknown' CHECK(source IN ('manual','mcp','system','unknown')),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type { EnvmanDatabase } from "./database-client.js";

export async function openDatabase(config: AppConfig): Promise<EnvmanDatabase> {
  if (config.databaseDriver === "mysql") {
    if (!config.databaseHost || !config.databaseName || !config.databaseUsername) {
      throw new Error("MySQL database configuration is incomplete.");
    }
    const db = new MysqlDatabaseClient({
      host: config.databaseHost,
      port: config.databasePort ?? 3306,
      database: config.databaseName,
      user: config.databaseUsername,
      password: config.databasePassword ?? "",
      connectionLimit: config.databasePoolSize ?? 10,
    });
    await db.exec(MYSQL_SCHEMA);
    await addMysqlColumnIfMissing(db, "api_keys", "mcp_approval_mode", "VARCHAR(16) NOT NULL DEFAULT 'always'");
    await addMysqlColumnIfMissing(db, "audit_events", "source", "VARCHAR(16) NOT NULL DEFAULT 'unknown'");
    await db.prepare("UPDATE audit_events SET source = 'mcp' WHERE source = 'unknown' AND action LIKE 'mcp.%'").run();
    await addMysqlColumnIfMissing(db, "database_query_favorites", "database_name", "VARCHAR(255) NOT NULL DEFAULT ''");
    await addMysqlColumnIfMissing(db, "database_connections", "profile_parent_id", "VARCHAR(64) NULL");
    await addMysqlColumnIfMissing(db, "database_connections", "profile_name", "VARCHAR(160) NOT NULL DEFAULT ''");
    await addMysqlColumnIfMissing(db, "ssh_connections", "ssh_key_id", "VARCHAR(64) NULL");
    await addMysqlForeignKeyIfMissing(
      db,
      "ssh_connections",
      "ssh_connections_key_fk",
      "FOREIGN KEY (`ssh_key_id`) REFERENCES `ssh_keys`(`id`) ON DELETE SET NULL",
    );
    await addMysqlColumnIfMissing(db, "projects", "parent_id", "VARCHAR(64) NULL");
    await addMysqlColumnIfMissing(db, "organization_invitation_policies", "project_id", "VARCHAR(64) NULL");
    await addMysqlColumnIfMissing(db, "organization_invitation_policies", "deleted_at", "VARCHAR(32) NULL");
    await addMysqlColumnIfMissing(db, "environments", "sort_order", "INT NOT NULL DEFAULT 0");
    await addMysqlColumnIfMissing(db, "environment_preferences", "is_favorite", "TINYINT NOT NULL DEFAULT 0");
    await addMysqlColumnIfMissing(db, "web_entries", "sort_order", "INT NOT NULL DEFAULT 0");
    await addMysqlColumnIfMissing(db, "web_credentials", "sort_order", "INT NOT NULL DEFAULT 0");
    await addMysqlColumnIfMissing(db, "services", "sort_order", "INT NOT NULL DEFAULT 0");
    await addMysqlColumnIfMissing(db, "ssh_connection_environments", "maintenance_sort_order", "INT NOT NULL DEFAULT 0");
    await addMysqlColumnIfMissing(db, "knowledge_nodes", "workspace_type", "VARCHAR(20) NOT NULL DEFAULT 'personal'");
    await addMysqlColumnIfMissing(db, "knowledge_nodes", "workspace_id", "VARCHAR(64) NOT NULL DEFAULT ''");
    await addMysqlColumnIfMissing(db, "monitor_hosts", "install_path", "VARCHAR(512) NOT NULL DEFAULT ''");
    await addMysqlColumnIfMissing(db, "monitor_hosts", "install_architecture", "VARCHAR(16) NOT NULL DEFAULT ''");
    await addMysqlColumnIfMissing(db, "monitor_hosts", "install_managed", "TINYINT NOT NULL DEFAULT 0");
    await addMysqlColumnIfMissing(db, "monitor_hosts", "installed_at", "VARCHAR(32) NULL");
    await addMysqlColumnIfMissing(db, "monitor_hosts", "latest_kubernetes_configs_json", "LONGTEXT NULL");
    await addMysqlColumnIfMissing(db, "monitor_alert_settings", "host_offline_enabled", "TINYINT NOT NULL DEFAULT 0");
    await db.prepare("UPDATE monitor_hosts SET latest_kubernetes_configs_json = '[]' WHERE latest_kubernetes_configs_json IS NULL").run();
    const monitorAgentIndex = await db.prepare("SHOW INDEX FROM `monitor_samples` WHERE Key_name = 'monitor_samples_agent_collected_idx'").get();
    if (!monitorAgentIndex) await db.exec("ALTER TABLE `monitor_samples` ADD KEY `monitor_samples_agent_collected_idx` (`agent_id`, `collected_at`)");
    await migrateMysqlKnowledgeSchema(db);
    await backfillInvitationAcceptances(db);
    await refreshPendingExistingConnections(db);
    await loadSavedSettings(db, config);
    return db;
  }

  mkdirSync(dirname(config.databasePath), { recursive: true });
  const raw = new Database(config.databasePath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  const db = new SqliteDatabaseClient(raw);
  raw.exec(SQLITE_SCHEMA);
  rebuildMonitorAlertRuleTables(raw);
  rebuildKnowledgeBaseTables(raw);
  rebuildServiceDeploymentProviderTable(raw);
  raw.exec(`
    CREATE INDEX IF NOT EXISTS knowledge_nodes_workspace_idx
      ON knowledge_nodes(workspace_type, workspace_id, parent_id, type, name);
  `);
  addColumnIfMissing(raw, "admin_users", "is_platform_admin", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "admin_users", "status", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(raw, "sessions", "workspace_type", "TEXT NOT NULL DEFAULT 'personal'");
  addColumnIfMissing(raw, "sessions", "workspace_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(raw, "api_keys", "mcp_approval_mode", "TEXT NOT NULL DEFAULT 'always'");
  addColumnIfMissing(raw, "projects", "parent_id", "TEXT REFERENCES projects(id) ON DELETE CASCADE");
  addColumnIfMissing(raw, "organization_invitation_policies", "project_id", "TEXT");
  addColumnIfMissing(raw, "organization_invitation_policies", "deleted_at", "TEXT");
  await backfillInvitationAcceptances(db);
  raw.exec("CREATE INDEX IF NOT EXISTS projects_parent_idx ON projects(organization_id, parent_id, name)");
  for (const table of ["environment_groups", "environments", "connection_sources", "connection_groups", "ssh_keys", "ssh_connections", "database_connections", "redis_connections", "connection_import_batches"]) {
    addColumnIfMissing(raw, table, "workspace_type", "TEXT NOT NULL DEFAULT 'personal'");
    addColumnIfMissing(raw, table, "workspace_id", "TEXT NOT NULL DEFAULT ''");
  }
  addColumnIfMissing(raw, "environments", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "environment_preferences", "is_favorite", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "web_entries", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "web_credentials", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "services", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "ssh_connection_environments", "maintenance_sort_order", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "monitor_hosts", "install_path", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(raw, "monitor_hosts", "install_architecture", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(raw, "monitor_hosts", "install_managed", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "monitor_hosts", "installed_at", "TEXT");
  addColumnIfMissing(raw, "monitor_hosts", "latest_kubernetes_configs_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(raw, "monitor_alert_settings", "host_offline_enabled", "INTEGER NOT NULL DEFAULT 0");
  rebuildWorkspaceScopedUniqueTables(raw);
  rebuildRedisCompatibleConstraintTables(raw);
  raw.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS environment_groups_workspace_name_idx
      ON environment_groups(workspace_type, workspace_id, name COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS connection_groups_workspace_path_idx
      ON connection_groups(workspace_type, workspace_id, type, path COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS connection_groups_parent_idx
      ON connection_groups(type, parent_id, sort_order, name);
  `);
  addColumnIfMissing(raw, "database_query_history", "owner_user_id", "TEXT REFERENCES admin_users(id) ON DELETE CASCADE");
  addColumnIfMissing(raw, "database_query_favorites", "owner_user_id", "TEXT REFERENCES admin_users(id) ON DELETE CASCADE");
  addColumnIfMissing(raw, "database_query_favorites", "database_name", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(raw, "database_tasks", "owner_user_id", "TEXT REFERENCES admin_users(id) ON DELETE CASCADE");
  addColumnIfMissing(raw, "ssh_terminal_recordings", "owner_user_id", "TEXT REFERENCES admin_users(id) ON DELETE CASCADE");
  addColumnIfMissing(raw, "audit_events", "actor_user_id", "TEXT REFERENCES admin_users(id) ON DELETE SET NULL");
  addColumnIfMissing(raw, "audit_events", "workspace_type", "TEXT");
  addColumnIfMissing(raw, "audit_events", "workspace_id", "TEXT");
  addColumnIfMissing(raw, "audit_events", "source", "TEXT NOT NULL DEFAULT 'unknown' CHECK(source IN ('manual','mcp','system','unknown'))");
  raw.prepare("UPDATE audit_events SET source = 'mcp' WHERE source = 'unknown' AND action LIKE 'mcp.%'").run();
  const sshColumns = raw.prepare("PRAGMA table_info(ssh_connections)").all() as Array<{ name: string }>;
  if (!sshColumns.some((column) => column.name === "connection_group_id")) {
    raw.exec("ALTER TABLE ssh_connections ADD COLUMN connection_group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL");
  }
  if (!sshColumns.some((column) => column.name === "tags_json")) {
    raw.exec("ALTER TABLE ssh_connections ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!sshColumns.some((column) => column.name === "ssh_key_id")) {
    raw.exec("ALTER TABLE ssh_connections ADD COLUMN ssh_key_id TEXT REFERENCES ssh_keys(id) ON DELETE SET NULL");
  }
  const databaseColumns = raw.prepare("PRAGMA table_info(database_connections)").all() as Array<{ name: string }>;
  if (!databaseColumns.some((column) => column.name === "connection_group_id")) {
    raw.exec("ALTER TABLE database_connections ADD COLUMN connection_group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL");
  }
  addColumnIfMissing(raw, "database_connections", "profile_parent_id", "TEXT REFERENCES database_connections(id) ON DELETE CASCADE");
  addColumnIfMissing(raw, "database_connections", "profile_name", "TEXT NOT NULL DEFAULT ''");
  raw.exec("CREATE INDEX IF NOT EXISTS database_connections_profile_idx ON database_connections(profile_parent_id, profile_name)");
  raw.exec(`
    INSERT OR IGNORE INTO ssh_connection_environments (connection_id, environment_id)
    SELECT id, environment_id FROM ssh_connections WHERE environment_id IS NOT NULL;
    INSERT OR IGNORE INTO database_connection_environments (connection_id, environment_id)
    SELECT id, environment_id FROM database_connections WHERE environment_id IS NOT NULL;
    INSERT OR IGNORE INTO redis_connection_environments (connection_id, environment_id)
    SELECT id, environment_id FROM redis_connections WHERE environment_id IS NOT NULL;
  `);
  const environmentLogColumns = raw.prepare("PRAGMA table_info(environment_logs)").all() as Array<{ name: string }>;
  if (!environmentLogColumns.some((column) => column.name === "file_paths_json")) {
    raw.exec("ALTER TABLE environment_logs ADD COLUMN file_paths_json TEXT NOT NULL DEFAULT '[]'");
    const existingLogs = raw.prepare("SELECT id, file_path FROM environment_logs").all() as Array<{ id: string; file_path: string }>;
    const migrateLogPaths = raw.prepare("UPDATE environment_logs SET file_paths_json = ? WHERE id = ?");
    const migrateEnvironmentLogs = raw.transaction(() => {
      for (const log of existingLogs) migrateLogPaths.run(JSON.stringify([log.file_path]), log.id);
    });
    migrateEnvironmentLogs();
  }
  await refreshPendingExistingConnections(db);
  await loadSavedSettings(db, config);
  return db;
}

export async function loadSavedSettings(db: EnvmanDatabase, config: AppConfig): Promise<void> {
  const savedSettings = await db.prepare("SELECT `key`, value_json FROM settings WHERE `key` IN ('auditRetentionDays', 'monitorPullIntervalSeconds')").all() as Array<{ key: string; value_json: string }>;
  for (const setting of savedSettings) {
    const value = Number(JSON.parse(setting.value_json));
    if (!Number.isInteger(value) || value <= 0) continue;
    if (setting.key === "auditRetentionDays") config.auditRetentionDays = value;
    if (setting.key === "monitorPullIntervalSeconds" && value >= 10 && value <= 3600) config.monitorPullIntervalSeconds = value;
  }
}

export async function ensureAdmin(db: EnvmanDatabase, config: AppConfig): Promise<void> {
  let administrator = await db.prepare("SELECT id FROM admin_users WHERE is_platform_admin = 1 LIMIT 1").get() as { id: string } | undefined;
  if (!administrator) {
    const existing = await db.prepare("SELECT id FROM admin_users ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    if (existing) {
      await db.prepare("UPDATE admin_users SET is_platform_admin = 1, status = 'active' WHERE id = ?").run(existing.id);
      administrator = existing;
    }
  }
  if (!administrator) {
    const passwordError = passwordPolicyError(config.adminPassword, config.allowWeakPasswords);
    if (passwordError) throw new Error(`ADMIN_PASSWORD is invalid: ${passwordError}`);
    const now = new Date().toISOString();
    const passwordHash = await argon2.hash(config.adminPassword, { type: argon2.argon2id });
    administrator = { id: crypto.randomUUID() };
    await db.prepare(`
      INSERT INTO admin_users (id, username, password_hash, is_platform_admin, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'active', ?, ?)
    `).run(administrator.id, config.adminUsername, passwordHash, now, now);
  }
  await claimLegacyResources(db, administrator.id);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function addMysqlColumnIfMissing(db: EnvmanDatabase, table: string, column: string, definition: string): Promise<void> {
  const existing = await db.prepare(`SHOW COLUMNS FROM \`${table}\` LIKE ?`).get(column);
  if (!existing) await db.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function addMysqlForeignKeyIfMissing(db: EnvmanDatabase, table: string, constraint: string, definition: string): Promise<void> {
  const existing = await db.prepare(`
    SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
  `).get(table, constraint);
  if (!existing) await db.exec(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` ${definition}`);
}

function rebuildMonitorAlertRuleTables(db: Database.Database): void {
  const tableSql = (table: string) => String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined)?.sql ?? "");
  if (/['"]host_offline['"]/i.test(tableSql("monitor_alert_states"))
    && /['"]disk_added['"]/i.test(tableSql("monitor_alert_states"))
    && /['"]disk_added['"]/i.test(tableSql("monitor_alerts"))
    && /['"]event['"]/i.test(tableSql("monitor_alerts"))) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE monitor_alert_states_host_offline_new (
          id TEXT PRIMARY KEY,
          environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK(target_type IN ('host','deployment')),
          target_id TEXT NOT NULL,
          rule_type TEXT NOT NULL CHECK(rule_type IN ('host_offline','cpu','memory','disk_usage','temperature','disk_added','disk_missing','deployment_status')),
          rule_key_hash TEXT NOT NULL,
          rule_key TEXT NOT NULL DEFAULT '',
          ssh_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
          service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
          deployment_id TEXT REFERENCES service_deployments(id) ON DELETE SET NULL,
          target_name TEXT NOT NULL DEFAULT '',
          connection_name TEXT NOT NULL DEFAULT '',
          service_name TEXT NOT NULL DEFAULT '',
          breach_count INTEGER NOT NULL DEFAULT 0,
          recovery_count INTEGER NOT NULL DEFAULT 0,
          active_alert_id TEXT,
          last_value_json TEXT NOT NULL DEFAULT '{}',
          last_evaluated_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(environment_id, target_type, target_id, rule_type, rule_key_hash)
        );
        INSERT INTO monitor_alert_states_host_offline_new (
          id, environment_id, target_type, target_id, rule_type, rule_key_hash, rule_key,
          ssh_connection_id, service_id, deployment_id, target_name, connection_name, service_name,
          breach_count, recovery_count, active_alert_id, last_value_json, last_evaluated_at, created_at, updated_at
        ) SELECT
          id, environment_id, target_type, target_id, rule_type, rule_key_hash, rule_key,
          ssh_connection_id, service_id, deployment_id, target_name, connection_name, service_name,
          breach_count, recovery_count, active_alert_id, last_value_json, last_evaluated_at, created_at, updated_at
        FROM monitor_alert_states;

        CREATE TABLE monitor_alerts_host_offline_new (
          id TEXT PRIMARY KEY,
          environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
          state_id TEXT REFERENCES monitor_alert_states(id) ON DELETE SET NULL,
          target_type TEXT NOT NULL CHECK(target_type IN ('host','deployment')),
          target_id TEXT NOT NULL,
          rule_type TEXT NOT NULL CHECK(rule_type IN ('host_offline','cpu','memory','disk_usage','temperature','disk_added','disk_missing','deployment_status')),
          rule_key TEXT NOT NULL DEFAULT '',
          ssh_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
          service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
          deployment_id TEXT REFERENCES service_deployments(id) ON DELETE SET NULL,
          environment_name TEXT NOT NULL,
          target_name TEXT NOT NULL DEFAULT '',
          connection_name TEXT NOT NULL DEFAULT '',
          service_name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('active','recovered','event')),
          details_json TEXT NOT NULL DEFAULT '{}',
          triggered_at TEXT NOT NULL,
          recovered_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO monitor_alerts_host_offline_new (
          id, environment_id, state_id, target_type, target_id, rule_type, rule_key,
          ssh_connection_id, service_id, deployment_id, environment_name, target_name,
          connection_name, service_name, status, details_json, triggered_at, recovered_at, created_at, updated_at
        ) SELECT
          id, environment_id, state_id, target_type, target_id, rule_type, rule_key,
          ssh_connection_id, service_id, deployment_id, environment_name, target_name,
          connection_name, service_name, status, details_json, triggered_at, recovered_at, created_at, updated_at
        FROM monitor_alerts;

        CREATE TABLE monitor_alert_user_states_host_offline_new (
          alert_id TEXT NOT NULL REFERENCES monitor_alerts(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
          active_notified_at TEXT,
          recovery_notified_at TEXT,
          read_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(alert_id, user_id)
        );
        INSERT INTO monitor_alert_user_states_host_offline_new
          SELECT alert_id, user_id, active_notified_at, recovery_notified_at, read_at, updated_at
          FROM monitor_alert_user_states;

        DROP TABLE monitor_alert_user_states;
        DROP TABLE monitor_alerts;
        DROP TABLE monitor_alert_states;
        ALTER TABLE monitor_alert_states_host_offline_new RENAME TO monitor_alert_states;
        ALTER TABLE monitor_alerts_host_offline_new RENAME TO monitor_alerts;
        ALTER TABLE monitor_alert_user_states_host_offline_new RENAME TO monitor_alert_user_states;
        CREATE INDEX monitor_alert_states_environment_idx
          ON monitor_alert_states(environment_id, active_alert_id, updated_at DESC);
        CREATE INDEX monitor_alerts_environment_idx
          ON monitor_alerts(environment_id, status, triggered_at DESC);
        CREATE INDEX monitor_alert_user_states_user_idx
          ON monitor_alert_user_states(user_id, read_at, updated_at DESC);
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (violation) throw new Error("Monitor alert rule migration left invalid foreign keys");
}

async function migrateMysqlKnowledgeSchema(db: EnvmanDatabase): Promise<void> {
  const environmentColumn = await db.prepare("SHOW COLUMNS FROM `knowledge_nodes` LIKE 'environment_id'").get() as { Null?: string } | undefined;
  const environmentForeignKey = await db.prepare(`
    SELECT rc.DELETE_RULE AS delete_rule
    FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
    WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
      AND rc.TABLE_NAME = 'knowledge_nodes'
      AND rc.CONSTRAINT_NAME = 'knowledge_nodes_environment_fk'
  `).get() as { delete_rule?: string } | undefined;
  if (environmentForeignKey && String(environmentForeignKey.delete_rule).toUpperCase() !== "SET NULL") {
    await db.exec("ALTER TABLE `knowledge_nodes` DROP FOREIGN KEY `knowledge_nodes_environment_fk`");
  }
  if (String(environmentColumn?.Null).toUpperCase() !== "YES") {
    await db.exec("ALTER TABLE `knowledge_nodes` MODIFY COLUMN `environment_id` VARCHAR(64) NULL");
  }
  await addMysqlForeignKeyIfMissing(
    db,
    "knowledge_nodes",
    "knowledge_nodes_environment_fk",
    "FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON DELETE SET NULL",
  );

  const siblingIndex = await db.prepare("SHOW INDEX FROM `knowledge_nodes` WHERE Key_name = 'knowledge_nodes_sibling_name_idx'").all() as Array<{ Column_name?: string; Seq_in_index?: number | string }>;
  const siblingColumns = siblingIndex
    .sort((left, right) => Number(left.Seq_in_index) - Number(right.Seq_in_index))
    .map((row) => String(row.Column_name));
  if (siblingColumns.length && siblingColumns.join(",") !== "workspace_type,workspace_id,parent_key,name") {
    await db.exec("ALTER TABLE `knowledge_nodes` DROP INDEX `knowledge_nodes_sibling_name_idx`");
  }
  const workspaceIndex = await db.prepare("SHOW INDEX FROM `knowledge_nodes` WHERE Key_name = 'knowledge_nodes_workspace_idx'").get();
  if (!workspaceIndex) {
    await db.exec("ALTER TABLE `knowledge_nodes` ADD KEY `knowledge_nodes_workspace_idx` (`workspace_type`, `workspace_id`, `parent_id`, `type`, `name`)");
  }
}

function rebuildKnowledgeBaseTables(db: Database.Database): void {
  const tableSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_nodes'").get() as { sql?: string } | undefined)?.sql ?? "");
  const columns = db.prepare("PRAGMA table_info(knowledge_nodes)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const needsRebuild = !columnNames.has("workspace_type")
    || !columnNames.has("workspace_id")
    || /environment_id\s+TEXT\s+NOT\s+NULL/i.test(tableSql)
    || /UNIQUE\s*\(\s*environment_id/i.test(tableSql);
  if (!needsRebuild) return;

  const workspaceType = columnNames.has("workspace_type")
    ? "workspace_type"
    : "COALESCE((SELECT e.workspace_type FROM environments e WHERE e.id = knowledge_nodes.environment_id), 'personal')";
  const workspaceId = columnNames.has("workspace_id")
    ? "workspace_id"
    : "COALESCE((SELECT e.workspace_id FROM environments e WHERE e.id = knowledge_nodes.environment_id), '')";
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE knowledge_nodes_workspace_new (
          id TEXT PRIMARY KEY,
          workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
          workspace_id TEXT NOT NULL DEFAULT '',
          environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
          parent_id TEXT REFERENCES knowledge_nodes_workspace_new(id) ON DELETE CASCADE,
          parent_key TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL CHECK(type IN ('folder','document')),
          name TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          revision INTEGER NOT NULL DEFAULT 1,
          created_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO knowledge_nodes_workspace_new (
          id, workspace_type, workspace_id, environment_id, parent_id, parent_key, type, name,
          content, revision, created_by_user_id, created_at, updated_at
        )
        SELECT id, ${workspaceType}, ${workspaceId}, environment_id, parent_id, parent_key, type, name,
          content, revision, created_by_user_id, created_at, updated_at
        FROM knowledge_nodes;
        DROP TABLE knowledge_nodes;
        ALTER TABLE knowledge_nodes_workspace_new RENAME TO knowledge_nodes;
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (violation) throw new Error("Knowledge base workspace migration left invalid foreign keys");
}

function rebuildServiceDeploymentProviderTable(db: Database.Database): void {
  const tableSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'service_deployments'").get() as { sql?: string } | undefined)?.sql ?? "");
  if (/['"]kubernetes['"]/i.test(tableSql)) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE service_deployments_kubernetes_new (
          id TEXT PRIMARY KEY,
          service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
          ssh_connection_id TEXT REFERENCES ssh_connections(id) ON DELETE SET NULL,
          ssh_connection_name TEXT NOT NULL DEFAULT '',
          provider_type TEXT NOT NULL CHECK(provider_type IN ('systemd','docker','podman','supervisor','kubernetes','process')),
          external_id TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('discovered','manual')),
          status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('running','stopped','degraded','unknown','disabled')),
          state_detail TEXT NOT NULL DEFAULT '',
          latest_metrics_json TEXT NOT NULL DEFAULT '{}',
          last_checked_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO service_deployments_kubernetes_new (
          id, service_id, ssh_connection_id, ssh_connection_name, provider_type, external_id,
          display_name, origin, status, state_detail, latest_metrics_json, last_checked_at, created_at, updated_at
        )
        SELECT id, service_id, ssh_connection_id, ssh_connection_name, provider_type, external_id,
          display_name, origin, status, state_detail, latest_metrics_json, last_checked_at, created_at, updated_at
        FROM service_deployments;
        DROP TABLE service_deployments;
        ALTER TABLE service_deployments_kubernetes_new RENAME TO service_deployments;
        CREATE UNIQUE INDEX service_deployments_target_idx
          ON service_deployments(service_id, ssh_connection_id, provider_type, external_id);
        CREATE INDEX service_deployments_connection_idx
          ON service_deployments(ssh_connection_id, updated_at DESC);
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (violation) throw new Error("Service deployment provider migration left invalid foreign keys");
}

async function migrateLegacyKnowledgeNodes(db: EnvmanDatabase): Promise<void> {
  const environments = await db.prepare(`
    SELECT e.id, e.workspace_type, e.workspace_id, e.name
    FROM environments e
    WHERE EXISTS (SELECT 1 FROM knowledge_nodes n WHERE n.environment_id = e.id)
    ORDER BY e.created_at, e.id
  `).all() as Array<{ id: string; workspace_type: "personal" | "organization"; workspace_id: string; name: string }>;
  for (const environment of environments) {
    await db.transaction(async () => {
      let folderName = environment.name.trim() || "未命名环境";
      for (let sequence = 1; sequence <= 10_000; sequence += 1) {
        const candidate = sequence === 1 ? folderName : `${folderName} (${sequence})`;
        const duplicate = await db.prepare(`
          SELECT 1 FROM knowledge_nodes
          WHERE workspace_type = ? AND workspace_id = ? AND parent_key = '' AND name = ? COLLATE NOCASE
        `).get(environment.workspace_type, environment.workspace_id, candidate);
        if (!duplicate) {
          folderName = candidate;
          break;
        }
      }
      const folderId = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.prepare(`
        INSERT INTO knowledge_nodes (
          id, workspace_type, workspace_id, environment_id, parent_id, parent_key, type, name,
          content, revision, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, '', 'folder', ?, '', 1, NULL, ?, ?)
      `).run(folderId, environment.workspace_type, environment.workspace_id, folderName, now, now);
      await db.prepare(`
        INSERT OR IGNORE INTO knowledge_node_environments (node_id, environment_id, assigned_by_user_id, assigned_at)
        SELECT id, ?, NULL, ? FROM knowledge_nodes WHERE environment_id = ?
      `).run(environment.id, now, environment.id);
      await db.prepare(`
        INSERT OR IGNORE INTO knowledge_node_environments (node_id, environment_id, assigned_by_user_id, assigned_at)
        VALUES (?, ?, NULL, ?)
      `).run(folderId, environment.id, now);
      await db.prepare(`
        UPDATE knowledge_nodes SET parent_id = ?, parent_key = ?
        WHERE environment_id = ? AND parent_id IS NULL
      `).run(folderId, folderId, environment.id);
      await db.prepare(`
        UPDATE knowledge_nodes SET workspace_type = ?, workspace_id = ?, environment_id = NULL
        WHERE environment_id = ?
      `).run(environment.workspace_type, environment.workspace_id, environment.id);
    })();
  }
  if (db.dialect === "sqlite") {
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS knowledge_nodes_workspace_name_idx
      ON knowledge_nodes(workspace_type, workspace_id, parent_key, name COLLATE NOCASE)
    `);
  } else {
    const siblingIndex = await db.prepare("SHOW INDEX FROM `knowledge_nodes` WHERE Key_name = 'knowledge_nodes_sibling_name_idx'").get();
    if (!siblingIndex) {
      await db.exec("ALTER TABLE `knowledge_nodes` ADD UNIQUE KEY `knowledge_nodes_sibling_name_idx` (`workspace_type`, `workspace_id`, `parent_key`, `name`)");
    }
  }
}

async function backfillInvitationAcceptances(db: EnvmanDatabase): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO organization_invitation_acceptances (
      invitation_id, user_id, accepted_at, joined_organization, joined_project
    )
    SELECT mi.invitation_id, mi.user_id, mi.accepted_at, 1,
      CASE WHEN p.project_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = p.project_id AND pm.user_id = mi.user_id
      ) THEN 1 ELSE 0 END
    FROM organization_member_invitations mi
    LEFT JOIN organization_invitation_policies p ON p.invitation_id = mi.invitation_id
  `).run();
  await db.prepare(`
    INSERT OR IGNORE INTO organization_invitation_acceptances (
      invitation_id, user_id, accepted_at, joined_organization, joined_project
    )
    SELECT i.id, i.accepted_by_user_id, i.accepted_at, 1,
      CASE WHEN p.project_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = p.project_id AND pm.user_id = i.accepted_by_user_id
      ) THEN 1 ELSE 0 END
    FROM organization_invitations i
    LEFT JOIN organization_invitation_policies p ON p.invitation_id = i.id
    WHERE i.accepted_by_user_id IS NOT NULL AND i.accepted_at IS NOT NULL
  `).run();
}

function rebuildWorkspaceScopedUniqueTables(db: Database.Database): void {
  const environmentGroupSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'environment_groups'").get() as { sql?: string } | undefined)?.sql ?? "");
  const connectionGroupSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connection_groups'").get() as { sql?: string } | undefined)?.sql ?? "");
  const rebuildEnvironmentGroups = /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(environmentGroupSql);
  const rebuildConnectionGroups = /UNIQUE\s*\(\s*type\s*,\s*path\s*\)/i.test(connectionGroupSql);
  if (!rebuildEnvironmentGroups && !rebuildConnectionGroups) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (rebuildEnvironmentGroups) {
        db.exec(`
          CREATE TABLE environment_groups_new (
            id TEXT PRIMARY KEY,
            workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
            workspace_id TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT '#1d8a74',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO environment_groups_new
            SELECT id, workspace_type, workspace_id, name, description, color, sort_order, created_at, updated_at FROM environment_groups;
          DROP TABLE environment_groups;
          ALTER TABLE environment_groups_new RENAME TO environment_groups;
        `);
      }
      if (rebuildConnectionGroups) {
        db.exec(`
          CREATE TABLE connection_groups_new (
            id TEXT PRIMARY KEY,
            workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
            workspace_id TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL CHECK(type IN ('ssh','database','redis')),
            parent_id TEXT REFERENCES connection_groups_new(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO connection_groups_new
            SELECT id, workspace_type, workspace_id, type, parent_id, name, path, sort_order, created_at, updated_at FROM connection_groups;
          DROP TABLE connection_groups;
          ALTER TABLE connection_groups_new RENAME TO connection_groups;
        `);
      }
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (violation) throw new Error("Workspace uniqueness migration left invalid foreign keys");
}

function rebuildRedisCompatibleConstraintTables(db: Database.Database): void {
  const tableSql = (table: string) => String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined)?.sql ?? "");
  const rebuildConnectionGroups = !/['"]redis['"]/i.test(tableSql("connection_groups"));
  const rebuildResourceGrants = !/['"]redis_connection['"]/i.test(tableSql("resource_grants"));
  const rebuildInspectionResults = !/['"]redis['"]/i.test(tableSql("connection_inspection_results"));
  if (!rebuildConnectionGroups && !rebuildResourceGrants && !rebuildInspectionResults) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      if (rebuildConnectionGroups) {
        db.exec(`
          CREATE TABLE connection_groups_redis_new (
            id TEXT PRIMARY KEY,
            workspace_type TEXT NOT NULL DEFAULT 'personal' CHECK(workspace_type IN ('personal','organization')),
            workspace_id TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL CHECK(type IN ('ssh','database','redis')),
            parent_id TEXT REFERENCES connection_groups_redis_new(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO connection_groups_redis_new
            SELECT id, workspace_type, workspace_id, type, parent_id, name, path, sort_order, created_at, updated_at FROM connection_groups;
          DROP TABLE connection_groups;
          ALTER TABLE connection_groups_redis_new RENAME TO connection_groups;
          CREATE UNIQUE INDEX connection_groups_workspace_path_idx
            ON connection_groups(workspace_type, workspace_id, type, path COLLATE NOCASE);
          CREATE INDEX connection_groups_parent_idx
            ON connection_groups(type, parent_id, sort_order, name);
        `);
      }
      if (rebuildResourceGrants) {
        db.exec(`
          CREATE TABLE resource_grants_redis_new (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            grantee_type TEXT NOT NULL CHECK(grantee_type IN ('user','project')),
            grantee_id TEXT NOT NULL,
            resource_type TEXT NOT NULL CHECK(resource_type IN ('environment_group','environment','ssh_connection','database_connection','redis_connection')),
            resource_id TEXT NOT NULL,
            created_by_user_id TEXT NOT NULL REFERENCES admin_users(id),
            created_at TEXT NOT NULL,
            UNIQUE(organization_id, grantee_type, grantee_id, resource_type, resource_id)
          );
          INSERT INTO resource_grants_redis_new
            SELECT id, organization_id, grantee_type, grantee_id, resource_type, resource_id, created_by_user_id, created_at FROM resource_grants;
          DROP TABLE resource_grants;
          ALTER TABLE resource_grants_redis_new RENAME TO resource_grants;
          CREATE INDEX resource_grants_grantee_idx
            ON resource_grants(organization_id, grantee_type, grantee_id);
          CREATE INDEX resource_grants_resource_idx
            ON resource_grants(organization_id, resource_type, resource_id);
        `);
      }
      if (rebuildInspectionResults) {
        db.exec(`
          CREATE TABLE connection_inspection_results_redis_new (
            connection_type TEXT NOT NULL CHECK(connection_type IN ('ssh','database','redis')),
            connection_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('available','unavailable')),
            latency_ms INTEGER NOT NULL DEFAULT 0,
            message TEXT NOT NULL DEFAULT '',
            checked_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
            checked_at TEXT NOT NULL,
            PRIMARY KEY(connection_type, connection_id)
          );
          INSERT INTO connection_inspection_results_redis_new
            SELECT connection_type, connection_id, status, latency_ms, message, checked_by_user_id, checked_at FROM connection_inspection_results;
          DROP TABLE connection_inspection_results;
          ALTER TABLE connection_inspection_results_redis_new RENAME TO connection_inspection_results;
          CREATE INDEX connection_inspection_results_checked_idx
            ON connection_inspection_results(checked_at DESC);
        `);
      }
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (violation) throw new Error("Redis connection constraint migration left invalid foreign keys");
}

async function claimLegacyResources(db: EnvmanDatabase, userId: string): Promise<void> {
  const claim = db.transaction(async () => {
    for (const table of ["environment_groups", "environments", "connection_sources", "connection_groups", "ssh_keys", "ssh_connections", "database_connections", "redis_connections", "connection_import_batches"]) {
      await db.prepare(`UPDATE ${table} SET workspace_type = 'personal', workspace_id = ? WHERE workspace_id = ''`).run(userId);
    }
    await db.prepare("UPDATE sessions SET workspace_type = 'personal', workspace_id = user_id WHERE workspace_id = ''").run();
    await db.prepare("UPDATE database_query_history SET owner_user_id = ? WHERE owner_user_id IS NULL").run(userId);
    await db.prepare("UPDATE database_query_favorites SET owner_user_id = ? WHERE owner_user_id IS NULL").run(userId);
    await db.prepare("UPDATE database_tasks SET owner_user_id = ? WHERE owner_user_id IS NULL").run(userId);
    await db.prepare("UPDATE ssh_terminal_recordings SET owner_user_id = ? WHERE owner_user_id IS NULL").run(userId);
    await db.prepare("UPDATE audit_events SET actor_user_id = COALESCE(actor_user_id, ?), workspace_type = COALESCE(workspace_type, 'personal'), workspace_id = COALESCE(workspace_id, ?) WHERE workspace_id IS NULL").run(userId, userId);
  });
  await claim();
  await migrateLegacyKnowledgeNodes(db);
}
