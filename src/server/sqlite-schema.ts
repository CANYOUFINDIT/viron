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
  cleared_at TEXT,
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
