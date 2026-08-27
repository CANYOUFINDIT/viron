export const MYSQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_platform_admin TINYINT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY admin_users_username_idx (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  token_hash VARCHAR(128) NOT NULL,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  expires_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  last_seen_at VARCHAR(32) NOT NULL,
  UNIQUE KEY sessions_token_hash_idx (token_hash),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_keys (
  id VARCHAR(64) PRIMARY KEY,
  key_type VARCHAR(16) NOT NULL,
  user_id VARCHAR(64),
  name VARCHAR(128) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  key_prefix VARCHAR(32) NOT NULL,
  mcp_approval_mode VARCHAR(16) NOT NULL DEFAULT 'always',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_by_user_id VARCHAR(64),
  last_used_at VARCHAR(32),
  created_at VARCHAR(32) NOT NULL,
  revoked_at VARCHAR(32),
  UNIQUE KEY api_keys_token_hash_idx (token_hash),
  KEY api_keys_owner_idx (key_type, user_id, status, created_at),
  CONSTRAINT api_keys_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT api_keys_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_key_login_tickets (
  id VARCHAR(64) PRIMARY KEY,
  api_key_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  workspace_type VARCHAR(16) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL,
  redirect_path VARCHAR(512) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  consumed_at VARCHAR(32),
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY api_key_login_tickets_token_hash_idx (token_hash),
  KEY api_key_login_tickets_expiry_idx (expires_at, consumed_at),
  CONSTRAINT api_key_login_tickets_key_fk FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  CONSTRAINT api_key_login_tickets_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organizations (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL,
  created_by_user_id VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY organizations_name_idx (name),
  CONSTRAINT organizations_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  KEY organization_members_user_idx (user_id, organization_id),
  CONSTRAINT organization_members_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT organization_members_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organization_invitations (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  created_by_user_id VARCHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  accepted_by_user_id VARCHAR(64),
  accepted_at VARCHAR(32),
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY organization_invitations_token_idx (token_hash),
  KEY organization_invitations_organization_idx (organization_id, created_at),
  CONSTRAINT organization_invitations_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT organization_invitations_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id),
  CONSTRAINT organization_invitations_acceptor_fk FOREIGN KEY (accepted_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organization_invitation_policies (
  invitation_id VARCHAR(64) PRIMARY KEY,
  token_ciphertext LONGTEXT,
  max_uses INT,
  used_count INT NOT NULL DEFAULT 0,
  revoked_at VARCHAR(32),
  deleted_at VARCHAR(32),
  project_id VARCHAR(64),
  CONSTRAINT organization_invitation_policies_invitation_fk FOREIGN KEY (invitation_id) REFERENCES organization_invitations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organization_invitation_acceptances (
  invitation_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  accepted_at VARCHAR(32) NOT NULL,
  joined_organization TINYINT(1) NOT NULL DEFAULT 0,
  joined_project TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (invitation_id, user_id),
  KEY organization_invitation_acceptances_user_idx (user_id, accepted_at),
  CONSTRAINT organization_invitation_acceptances_invitation_fk FOREIGN KEY (invitation_id) REFERENCES organization_invitations(id) ON DELETE CASCADE,
  CONSTRAINT organization_invitation_acceptances_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organization_member_invitations (
  organization_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  invitation_id VARCHAR(64) NOT NULL,
  invited_by_user_id VARCHAR(64),
  accepted_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  KEY organization_member_invitations_invitation_idx (invitation_id, accepted_at),
  KEY organization_member_invitations_inviter_idx (invited_by_user_id, accepted_at),
  CONSTRAINT organization_member_invitations_member_fk FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE,
  CONSTRAINT organization_member_invitations_invitation_fk FOREIGN KEY (invitation_id) REFERENCES organization_invitations(id) ON DELETE CASCADE,
  CONSTRAINT organization_member_invitations_inviter_fk FOREIGN KEY (invited_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL,
  parent_id VARCHAR(64),
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY projects_organization_name_idx (organization_id, name),
  KEY projects_parent_idx (organization_id, parent_id, name),
  CONSTRAINT projects_parent_fk FOREIGN KEY (parent_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT projects_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_members (
  project_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (project_id, user_id),
  KEY project_members_user_idx (user_id, project_id),
  CONSTRAINT project_members_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT project_members_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS resource_grants (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL,
  grantee_type VARCHAR(16) NOT NULL,
  grantee_id VARCHAR(64) NOT NULL,
  resource_type VARCHAR(32) NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  created_by_user_id VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY resource_grants_unique_idx (organization_id, grantee_type, grantee_id, resource_type, resource_id),
  KEY resource_grants_grantee_idx (organization_id, grantee_type, grantee_id),
  KEY resource_grants_resource_idx (organization_id, resource_type, resource_id),
  CONSTRAINT resource_grants_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT resource_grants_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS environment_groups (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  color VARCHAR(32) NOT NULL DEFAULT '#1d8a74',
  sort_order INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY environment_groups_workspace_name_idx (workspace_type, workspace_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS environments (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  group_id VARCHAR(64) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  name VARCHAR(255) NOT NULL,
  short_name VARCHAR(255) NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  owner VARCHAR(255) NOT NULL DEFAULT '',
  tags_json LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY environments_group_idx (group_id),
  KEY environments_status_idx (status),
  CONSTRAINT environments_group_fk FOREIGN KEY (group_id) REFERENCES environment_groups(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS environment_preferences (
  owner_user_id VARCHAR(64) NOT NULL,
  environment_id VARCHAR(64) NOT NULL,
  alias_name VARCHAR(120) NOT NULL DEFAULT '',
  is_favorite TINYINT NOT NULL DEFAULT 0,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (owner_user_id, environment_id),
  CONSTRAINT environment_preferences_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT environment_preferences_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  environment_id VARCHAR(64) NULL,
  parent_id VARCHAR(64),
  parent_key VARCHAR(64) NOT NULL DEFAULT '',
  type VARCHAR(16) NOT NULL,
  name VARCHAR(180) NOT NULL,
  content LONGTEXT NOT NULL,
  revision INT NOT NULL DEFAULT 1,
  created_by_user_id VARCHAR(64),
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY knowledge_nodes_sibling_name_idx (workspace_type, workspace_id, parent_key, name),
  KEY knowledge_nodes_workspace_idx (workspace_type, workspace_id, parent_id, type, name),
  CONSTRAINT knowledge_nodes_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  CONSTRAINT knowledge_nodes_parent_fk FOREIGN KEY (parent_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  CONSTRAINT knowledge_nodes_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS knowledge_node_environments (
  node_id VARCHAR(64) NOT NULL,
  environment_id VARCHAR(64) NOT NULL,
  assigned_by_user_id VARCHAR(64),
  assigned_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (node_id, environment_id),
  KEY knowledge_node_environments_environment_idx (environment_id, node_id),
  CONSTRAINT knowledge_node_environments_node_fk FOREIGN KEY (node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  CONSTRAINT knowledge_node_environments_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CONSTRAINT knowledge_node_environments_assigner_fk FOREIGN KEY (assigned_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS knowledge_node_grants (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL,
  node_id VARCHAR(64) NOT NULL,
  grantee_type VARCHAR(16) NOT NULL,
  grantee_id VARCHAR(64) NOT NULL,
  created_by_user_id VARCHAR(64),
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY knowledge_node_grants_unique_idx (organization_id, node_id, grantee_type, grantee_id),
  KEY knowledge_node_grants_grantee_idx (organization_id, grantee_type, grantee_id),
  KEY knowledge_node_grants_node_idx (node_id, created_at),
  CONSTRAINT knowledge_node_grants_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT knowledge_node_grants_node_fk FOREIGN KEY (node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  CONSTRAINT knowledge_node_grants_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS knowledge_assets (
  id VARCHAR(64) PRIMARY KEY,
  document_id VARCHAR(64) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(64) NOT NULL,
  data_base64 LONGTEXT NOT NULL,
  size_bytes INT NOT NULL,
  created_by_user_id VARCHAR(64),
  created_at VARCHAR(32) NOT NULL,
  KEY knowledge_assets_document_idx (document_id, created_at),
  CONSTRAINT knowledge_assets_document_fk FOREIGN KEY (document_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  CONSTRAINT knowledge_assets_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_entries (
  id VARCHAR(64) PRIMARY KEY,
  environment_id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL,
  tags_json LONGTEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT web_entries_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_credentials (
  id VARCHAR(64) PRIMARY KEY,
  web_entry_id VARCHAR(64) NOT NULL,
  username VARCHAR(255) NOT NULL,
  password_ciphertext LONGTEXT NOT NULL,
  note TEXT NOT NULL,
  custom_fields_json LONGTEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT web_credentials_entry_fk FOREIGN KEY (web_entry_id) REFERENCES web_entries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS desktop_devices (
  device_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  public_key_pem LONGTEXT NOT NULL,
  key_id CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  last_seen_at VARCHAR(32) NOT NULL,
  KEY desktop_devices_user_idx (user_id, status),
  CONSTRAINT desktop_devices_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS desktop_operation_reports (
  operation_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY desktop_operation_reports_expiry_idx (expires_at),
  CONSTRAINT desktop_operation_reports_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT desktop_operation_reports_device_fk FOREIGN KEY (device_id) REFERENCES desktop_devices(device_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS desktop_device_challenges (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  public_key_pem LONGTEXT NOT NULL,
  key_id CHAR(64) NOT NULL,
  challenge_hash CHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY desktop_device_challenges_expiry_idx (expires_at),
  CONSTRAINT desktop_device_challenges_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS desktop_credential_requests (
  request_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  credential_id VARCHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY desktop_credential_requests_expiry_idx (expires_at),
  CONSTRAINT desktop_credential_requests_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT desktop_credential_requests_device_fk FOREIGN KEY (device_id) REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  CONSTRAINT desktop_credential_requests_credential_fk FOREIGN KEY (credential_id) REFERENCES web_credentials(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_account_views (
  owner_user_id VARCHAR(64) NOT NULL,
  credential_id VARCHAR(64) NOT NULL,
  last_url TEXT NOT NULL,
  last_title TEXT NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (owner_user_id, credential_id),
  KEY web_account_views_updated_idx (updated_at),
  CONSTRAINT web_account_views_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT web_account_views_credential_fk FOREIGN KEY (credential_id) REFERENCES web_credentials(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connection_sources (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  type VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  config_ciphertext LONGTEXT NOT NULL,
  schedule_enabled TINYINT NOT NULL DEFAULT 0,
  schedule_expression VARCHAR(255) NULL,
  last_synced_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connection_source_runs (
  id VARCHAR(64) PRIMARY KEY,
  source_id VARCHAR(64) NOT NULL,
  workspace_type VARCHAR(20) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL,
  triggered_by_user_id VARCHAR(64) NULL,
  trigger_type VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  conflict_strategy VARCHAR(16) NOT NULL,
  started_at VARCHAR(32) NOT NULL,
  completed_at VARCHAR(32) NULL,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  summary_json LONGTEXT NOT NULL,
  items_json LONGTEXT NOT NULL,
  error_message TEXT NOT NULL,
  KEY connection_source_runs_source_idx (source_id, started_at),
  KEY connection_source_runs_workspace_idx (workspace_type, workspace_id, started_at),
  CONSTRAINT connection_source_runs_source_fk FOREIGN KEY (source_id) REFERENCES connection_sources(id) ON DELETE CASCADE,
  CONSTRAINT connection_source_runs_user_fk FOREIGN KEY (triggered_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connection_groups (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  type VARCHAR(16) NOT NULL,
  parent_id VARCHAR(64) NULL,
  name VARCHAR(255) NOT NULL,
  path TEXT NOT NULL,
  path_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(path, 256))) PERSISTENT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY connection_groups_workspace_path_idx (workspace_type, workspace_id, type, path_hash),
  KEY connection_groups_parent_idx (type, parent_id, sort_order, name),
  CONSTRAINT connection_groups_parent_fk FOREIGN KEY (parent_id) REFERENCES connection_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ssh_keys (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  algorithm VARCHAR(64) NOT NULL,
  public_key LONGTEXT NOT NULL,
  fingerprint VARCHAR(255) NOT NULL,
  private_key_ciphertext LONGTEXT NOT NULL,
  created_by_user_id VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ssh_keys_workspace_name_idx (workspace_type, workspace_id, name),
  KEY ssh_keys_workspace_fingerprint_idx (workspace_type, workspace_id, fingerprint),
  CONSTRAINT ssh_keys_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ssh_connections (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  environment_id VARCHAR(64) NULL,
  connection_group_id VARCHAR(64) NULL,
  source_id VARCHAR(64) NULL,
  source_item_id VARCHAR(512) NULL,
  source_path TEXT NULL,
  name VARCHAR(255) NOT NULL,
  host VARCHAR(255) NOT NULL,
  port INT NOT NULL DEFAULT 22,
  username VARCHAR(255) NOT NULL,
  auth_type VARCHAR(32) NOT NULL DEFAULT 'password',
  ssh_key_id VARCHAR(64) NULL,
  credential_ciphertext LONGTEXT NOT NULL,
  jump_connection_id VARCHAR(64) NULL,
  options_json LONGTEXT NOT NULL,
  tags_json LONGTEXT NOT NULL,
  source_deleted TINYINT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ssh_connections_source_item_idx (source_id, source_item_id),
  CONSTRAINT ssh_connections_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  CONSTRAINT ssh_connections_group_fk FOREIGN KEY (connection_group_id) REFERENCES connection_groups(id) ON DELETE SET NULL,
  CONSTRAINT ssh_connections_source_fk FOREIGN KEY (source_id) REFERENCES connection_sources(id) ON DELETE SET NULL,
  CONSTRAINT ssh_connections_key_fk FOREIGN KEY (ssh_key_id) REFERENCES ssh_keys(id) ON DELETE SET NULL,
  CONSTRAINT ssh_connections_jump_fk FOREIGN KEY (jump_connection_id) REFERENCES ssh_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ssh_connection_environments (
  connection_id VARCHAR(64) NOT NULL,
  environment_id VARCHAR(64) NOT NULL,
  maintenance_sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, environment_id),
  KEY ssh_connection_environments_environment_idx (environment_id, connection_id),
  CONSTRAINT ssh_connection_environments_connection_fk FOREIGN KEY (connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE,
  CONSTRAINT ssh_connection_environments_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS desktop_ssh_credential_requests (
  request_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY desktop_ssh_credential_requests_expiry_idx (expires_at),
  CONSTRAINT desktop_ssh_credential_requests_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT desktop_ssh_credential_requests_device_fk FOREIGN KEY (device_id) REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  CONSTRAINT desktop_ssh_credential_requests_connection_fk FOREIGN KEY (connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS environment_logs (
  id VARCHAR(64) PRIMARY KEY,
  environment_id VARCHAR(64) NOT NULL,
  ssh_connection_id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  file_path_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(file_path, 256))) PERSISTENT,
  file_paths_json LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY environment_logs_unique_idx (environment_id, ssh_connection_id, file_path_hash),
  KEY environment_logs_environment_idx (environment_id, updated_at),
  CONSTRAINT environment_logs_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CONSTRAINT environment_logs_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS services (
  id VARCHAR(64) PRIMARY KEY,
  environment_id VARCHAR(64) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY services_environment_name_idx (environment_id, name),
  KEY services_environment_idx (environment_id, updated_at),
  CONSTRAINT services_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_deployments (
  id VARCHAR(64) PRIMARY KEY,
  service_id VARCHAR(64) NOT NULL,
  ssh_connection_id VARCHAR(64) NULL,
  ssh_connection_name VARCHAR(255) NOT NULL DEFAULT '',
  provider_type VARCHAR(24) NOT NULL,
  external_id VARCHAR(512) NOT NULL,
  display_name VARCHAR(255) NOT NULL DEFAULT '',
  origin VARCHAR(16) NOT NULL DEFAULT 'manual',
  status VARCHAR(16) NOT NULL DEFAULT 'unknown',
  state_detail VARCHAR(255) NOT NULL DEFAULT '',
  latest_metrics_json LONGTEXT NOT NULL,
  last_checked_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY service_deployments_target_idx (service_id, ssh_connection_id, provider_type, external_id),
  KEY service_deployments_connection_idx (ssh_connection_id, updated_at),
  CONSTRAINT service_deployments_service_fk FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT service_deployments_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_log_links (
  service_id VARCHAR(64) NOT NULL,
  environment_log_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (service_id, environment_log_id),
  CONSTRAINT service_log_links_service_fk FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT service_log_links_log_fk FOREIGN KEY (environment_log_id) REFERENCES environment_logs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_script_actions (
  id VARCHAR(64) PRIMARY KEY,
  service_id VARCHAR(64) NOT NULL,
  deployment_id VARCHAR(64) NULL,
  name VARCHAR(80) NOT NULL,
  icon VARCHAR(32) NOT NULL DEFAULT 'terminal',
  script_body LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY service_script_actions_service_idx (service_id, deployment_id, created_at),
  CONSTRAINT service_script_actions_service_fk FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT service_script_actions_deployment_fk FOREIGN KEY (deployment_id) REFERENCES service_deployments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monitor_hosts (
  ssh_connection_id VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL DEFAULT '',
  agent_version VARCHAR(64) NOT NULL DEFAULT '',
  protocol_version INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'unknown',
  last_sequence BIGINT NOT NULL DEFAULT 0,
  latest_host_json LONGTEXT NOT NULL,
  latest_candidates_json LONGTEXT NOT NULL,
  latest_kubernetes_configs_json LONGTEXT NOT NULL,
  last_error TEXT NOT NULL,
  last_collected_at VARCHAR(32) NULL,
  last_pulled_at VARCHAR(32) NULL,
  install_path VARCHAR(512) NOT NULL DEFAULT '',
  install_architecture VARCHAR(16) NOT NULL DEFAULT '',
  install_managed TINYINT NOT NULL DEFAULT 0,
  installed_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT monitor_hosts_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monitor_samples (
  ssh_connection_id VARCHAR(64) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  sequence_start BIGINT NOT NULL,
  sequence_end BIGINT NOT NULL,
  collected_at VARCHAR(32) NOT NULL,
  resolution_seconds INT NOT NULL,
  payload_json LONGTEXT NOT NULL,
  received_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (ssh_connection_id, agent_id, sequence_end),
  KEY monitor_samples_collected_idx (ssh_connection_id, collected_at),
  KEY monitor_samples_agent_collected_idx (agent_id, collected_at),
  CONSTRAINT monitor_samples_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monitor_sequence_gaps (
  ssh_connection_id VARCHAR(64) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  sequence_start BIGINT NOT NULL,
  sequence_end BIGINT NOT NULL,
  started_at VARCHAR(32) NOT NULL,
  ended_at VARCHAR(32) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  received_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (ssh_connection_id, agent_id, sequence_end),
  CONSTRAINT monitor_sequence_gaps_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monitor_install_tasks (
  id VARCHAR(64) PRIMARY KEY,
  environment_id VARCHAR(64) NOT NULL,
  ssh_connection_id VARCHAR(64) NOT NULL,
  connection_name VARCHAR(255) NOT NULL,
  install_path VARCHAR(512) NOT NULL,
  actor_user_id VARCHAR(64) NULL,
  status VARCHAR(16) NOT NULL,
  phase VARCHAR(32) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  current_message TEXT NOT NULL,
  logs_json LONGTEXT NOT NULL,
  error_message TEXT NOT NULL,
  result_json LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  started_at VARCHAR(32) NULL,
  completed_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY monitor_install_tasks_connection_idx (ssh_connection_id, created_at),
  CONSTRAINT monitor_install_tasks_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CONSTRAINT monitor_install_tasks_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE,
  CONSTRAINT monitor_install_tasks_actor_fk FOREIGN KEY (actor_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monitor_alert_settings (
  environment_id VARCHAR(64) PRIMARY KEY,
  enabled TINYINT NOT NULL DEFAULT 0,
  host_offline_enabled TINYINT NOT NULL DEFAULT 0,
  cpu_enabled TINYINT NOT NULL DEFAULT 1,
  cpu_threshold DOUBLE NOT NULL DEFAULT 90,
  memory_enabled TINYINT NOT NULL DEFAULT 1,
  memory_threshold DOUBLE NOT NULL DEFAULT 90,
  disk_usage_enabled TINYINT NOT NULL DEFAULT 1,
  disk_usage_threshold DOUBLE NOT NULL DEFAULT 90,
  temperature_enabled TINYINT NOT NULL DEFAULT 1,
  temperature_threshold DOUBLE NOT NULL DEFAULT 80,
  deployment_status_enabled TINYINT NOT NULL DEFAULT 1,
  disk_missing_enabled TINYINT NOT NULL DEFAULT 1,
  tls_enabled TINYINT NOT NULL DEFAULT 1,
  tls_warn_days INT NOT NULL DEFAULT 14,
  tls_hostname_mismatch_enabled TINYINT NOT NULL DEFAULT 1,
  excluded_disks_json LONGTEXT NOT NULL,
  updated_by_user_id VARCHAR(64) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT monitor_alert_settings_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CONSTRAINT monitor_alert_settings_user_fk FOREIGN KEY (updated_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monitor_alert_states (
  id VARCHAR(64) PRIMARY KEY,
  environment_id VARCHAR(64) NOT NULL,
  target_type VARCHAR(16) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  rule_type VARCHAR(32) NOT NULL,
  rule_key_hash CHAR(64) NOT NULL,
  rule_key TEXT NOT NULL,
  ssh_connection_id VARCHAR(64) NULL,
  service_id VARCHAR(64) NULL,
  deployment_id VARCHAR(64) NULL,
  target_name VARCHAR(255) NOT NULL DEFAULT '',
  connection_name VARCHAR(255) NOT NULL DEFAULT '',
  service_name VARCHAR(160) NOT NULL DEFAULT '',
  breach_count INT NOT NULL DEFAULT 0,
  recovery_count INT NOT NULL DEFAULT 0,
  active_alert_id VARCHAR(64) NULL,
  last_value_json LONGTEXT NOT NULL,
  last_evaluated_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY monitor_alert_states_rule_idx (environment_id, target_type, target_id, rule_type, rule_key_hash),
  KEY monitor_alert_states_environment_idx (environment_id, active_alert_id, updated_at),
  CONSTRAINT monitor_alert_states_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CONSTRAINT monitor_alert_states_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE SET NULL,
  CONSTRAINT monitor_alert_states_service_fk FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL,
  CONSTRAINT monitor_alert_states_deployment_fk FOREIGN KEY (deployment_id) REFERENCES service_deployments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monitor_alerts (
  id VARCHAR(64) PRIMARY KEY,
  environment_id VARCHAR(64) NOT NULL,
  state_id VARCHAR(64) NULL,
  target_type VARCHAR(16) NOT NULL,
  target_id VARCHAR(64) NOT NULL,
  rule_type VARCHAR(32) NOT NULL,
  rule_key TEXT NOT NULL,
  ssh_connection_id VARCHAR(64) NULL,
  service_id VARCHAR(64) NULL,
  deployment_id VARCHAR(64) NULL,
  environment_name VARCHAR(255) NOT NULL,
  target_name VARCHAR(255) NOT NULL DEFAULT '',
  connection_name VARCHAR(255) NOT NULL DEFAULT '',
  service_name VARCHAR(160) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL,
  details_json LONGTEXT NOT NULL,
  triggered_at VARCHAR(32) NOT NULL,
  recovered_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY monitor_alerts_environment_idx (environment_id, status, triggered_at),
  CONSTRAINT monitor_alerts_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CONSTRAINT monitor_alerts_state_fk FOREIGN KEY (state_id) REFERENCES monitor_alert_states(id) ON DELETE SET NULL,
  CONSTRAINT monitor_alerts_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE SET NULL,
  CONSTRAINT monitor_alerts_service_fk FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL,
  CONSTRAINT monitor_alerts_deployment_fk FOREIGN KEY (deployment_id) REFERENCES service_deployments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS monitor_alert_user_states (
  alert_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  active_notified_at VARCHAR(32) NULL,
  recovery_notified_at VARCHAR(32) NULL,
  read_at VARCHAR(32) NULL,
  cleared_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (alert_id, user_id),
  KEY monitor_alert_user_states_user_idx (user_id, read_at, updated_at),
  CONSTRAINT monitor_alert_user_states_alert_fk FOREIGN KEY (alert_id) REFERENCES monitor_alerts(id) ON DELETE CASCADE,
  CONSTRAINT monitor_alert_user_states_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_connections (
  id VARCHAR(64) PRIMARY KEY,
  profile_parent_id VARCHAR(64) NULL,
  profile_name VARCHAR(160) NOT NULL DEFAULT '',
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  environment_id VARCHAR(64) NULL,
  connection_group_id VARCHAR(64) NULL,
  source_id VARCHAR(64) NULL,
  source_item_id VARCHAR(512) NULL,
  source_path TEXT NULL,
  name VARCHAR(255) NOT NULL,
  engine VARCHAR(16) NOT NULL,
  host VARCHAR(255) NOT NULL,
  port INT NOT NULL,
  username VARCHAR(255) NOT NULL,
  credential_ciphertext LONGTEXT NOT NULL,
  default_database VARCHAR(255) NOT NULL DEFAULT '',
  connection_mode VARCHAR(32) NOT NULL DEFAULT 'tcp',
  options_json LONGTEXT NOT NULL,
  source_deleted TINYINT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY database_connections_source_item_idx (source_id, source_item_id),
  KEY database_connections_profile_idx (profile_parent_id, profile_name),
  CONSTRAINT database_connections_profile_fk FOREIGN KEY (profile_parent_id) REFERENCES database_connections(id) ON DELETE CASCADE,
  CONSTRAINT database_connections_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  CONSTRAINT database_connections_group_fk FOREIGN KEY (connection_group_id) REFERENCES connection_groups(id) ON DELETE SET NULL,
  CONSTRAINT database_connections_source_fk FOREIGN KEY (source_id) REFERENCES connection_sources(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS desktop_database_credential_requests (
  request_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY desktop_database_credential_requests_expiry_idx (expires_at),
  CONSTRAINT desktop_database_credential_requests_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT desktop_database_credential_requests_device_fk FOREIGN KEY (device_id) REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  CONSTRAINT desktop_database_credential_requests_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_connection_environments (
  connection_id VARCHAR(64) NOT NULL,
  environment_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (connection_id, environment_id),
  KEY database_connection_environments_environment_idx (environment_id, connection_id),
  CONSTRAINT database_connection_environments_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE,
  CONSTRAINT database_connection_environments_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS redis_connections (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  environment_id VARCHAR(64) NULL,
  connection_group_id VARCHAR(64) NULL,
  source_id VARCHAR(64) NULL,
  source_item_id VARCHAR(512) NULL,
  source_path TEXT NULL,
  name VARCHAR(255) NOT NULL,
  host VARCHAR(255) NOT NULL,
  port INT NOT NULL DEFAULT 6379,
  username VARCHAR(255) NOT NULL DEFAULT '',
  credential_ciphertext LONGTEXT NOT NULL,
  default_database INT NOT NULL DEFAULT 0,
  connection_mode VARCHAR(32) NOT NULL DEFAULT 'tcp',
  options_json LONGTEXT NOT NULL,
  source_deleted TINYINT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY redis_connections_source_item_idx (source_id, source_item_id),
  CONSTRAINT redis_connections_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  CONSTRAINT redis_connections_group_fk FOREIGN KEY (connection_group_id) REFERENCES connection_groups(id) ON DELETE SET NULL,
  CONSTRAINT redis_connections_source_fk FOREIGN KEY (source_id) REFERENCES connection_sources(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS desktop_redis_credential_requests (
  request_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY desktop_redis_credential_requests_expiry_idx (expires_at),
  CONSTRAINT desktop_redis_credential_requests_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT desktop_redis_credential_requests_device_fk FOREIGN KEY (device_id) REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  CONSTRAINT desktop_redis_credential_requests_connection_fk FOREIGN KEY (connection_id) REFERENCES redis_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS redis_connection_environments (
  connection_id VARCHAR(64) NOT NULL,
  environment_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (connection_id, environment_id),
  KEY redis_connection_environments_environment_idx (environment_id, connection_id),
  CONSTRAINT redis_connection_environments_connection_fk FOREIGN KEY (connection_id) REFERENCES redis_connections(id) ON DELETE CASCADE,
  CONSTRAINT redis_connection_environments_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS source_folder_mappings (
  id VARCHAR(64) PRIMARY KEY,
  source_id VARCHAR(64) NOT NULL,
  source_path_prefix TEXT NOT NULL,
  source_path_prefix_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(source_path_prefix, 256))) PERSISTENT,
  environment_id VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY source_folder_mappings_unique_idx (source_id, source_path_prefix_hash),
  CONSTRAINT source_folder_mappings_source_fk FOREIGN KEY (source_id) REFERENCES connection_sources(id) ON DELETE CASCADE,
  CONSTRAINT source_folder_mappings_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_query_history (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NULL,
  connection_id VARCHAR(64) NULL,
  database_name VARCHAR(255) NOT NULL DEFAULT '',
  sql_text LONGTEXT NOT NULL,
  status VARCHAR(16) NOT NULL,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  row_count BIGINT NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY database_query_history_connection_idx (connection_id, created_at),
  CONSTRAINT database_query_history_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_query_history_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_query_favorites (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NULL,
  connection_id VARCHAR(64) NULL,
  database_name VARCHAR(255) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  sql_text LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY database_query_favorites_connection_idx (connection_id, updated_at),
  CONSTRAINT database_query_favorites_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_query_favorites_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_saved_queries (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  database_name VARCHAR(255) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  sql_text LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  accessed_at VARCHAR(32) NOT NULL,
  UNIQUE KEY database_saved_queries_unique_idx (owner_user_id, connection_id, database_name, name),
  KEY database_saved_queries_connection_idx (connection_id, database_name, name),
  CONSTRAINT database_saved_queries_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_saved_queries_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_table_profiles (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  database_name VARCHAR(64) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  name VARCHAR(160) NOT NULL,
  config_json LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  accessed_at VARCHAR(32) NOT NULL,
  UNIQUE KEY database_table_profiles_unique_idx (owner_user_id, connection_id, database_name, table_name, name),
  KEY database_table_profiles_connection_idx (connection_id, database_name, table_name, name),
  CONSTRAINT database_table_profiles_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_table_profiles_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_automation_jobs (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  connection_id VARCHAR(64) NOT NULL,
  database_name VARCHAR(255) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  works_json LONGTEXT NOT NULL,
  advanced_json LONGTEXT NOT NULL,
  schedule_cron VARCHAR(255) NOT NULL DEFAULT '',
  schedule_enabled TINYINT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'idle',
  logs_json LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  accessed_at VARCHAR(32) NOT NULL,
  last_run_at VARCHAR(32) NULL,
  UNIQUE KEY database_automation_jobs_unique_idx (owner_user_id, workspace_type, workspace_id, name),
  KEY database_automation_jobs_connection_idx (connection_id, database_name, updated_at),
  CONSTRAINT database_automation_jobs_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_automation_jobs_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_models (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  connection_id VARCHAR(64) NULL,
  database_name VARCHAR(255) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  model_type VARCHAR(16) NOT NULL,
  database_engine VARCHAR(64) NOT NULL DEFAULT 'MySQL',
  database_version VARCHAR(32) NOT NULL DEFAULT '8.1',
  model_json LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  accessed_at VARCHAR(32) NOT NULL,
  UNIQUE KEY database_models_unique_idx (owner_user_id, workspace_type, workspace_id, name),
  KEY database_models_connection_idx (connection_id, updated_at),
  CONSTRAINT database_models_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_models_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_code_snippets (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  sql_text LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY database_code_snippets_unique_idx (owner_user_id, workspace_type, workspace_id, name),
  CONSTRAINT database_code_snippets_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_bi_workspaces (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  connection_id VARCHAR(64) NULL,
  name VARCHAR(255) NOT NULL,
  document_json LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  accessed_at VARCHAR(32) NOT NULL,
  UNIQUE KEY database_bi_workspaces_unique_idx (owner_user_id, workspace_type, workspace_id, name),
  KEY database_bi_workspaces_connection_idx (connection_id, updated_at),
  CONSTRAINT database_bi_workspaces_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_bi_workspaces_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_object_groups (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  database_name VARCHAR(255) NOT NULL,
  category VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY database_object_groups_unique_idx (owner_user_id, connection_id, database_name, category, name),
  CONSTRAINT database_object_groups_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_object_groups_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_object_group_members (
  group_id VARCHAR(64) NOT NULL,
  object_name VARCHAR(255) NOT NULL,
  object_source VARCHAR(32) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (group_id, object_name, object_source),
  CONSTRAINT database_object_group_members_group_fk FOREIGN KEY (group_id) REFERENCES database_object_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_object_favorites (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  target_type VARCHAR(16) NOT NULL,
  database_name VARCHAR(255) NOT NULL,
  table_name VARCHAR(255) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY database_object_favorites_unique_idx (owner_user_id, connection_id, target_type, database_name, table_name),
  KEY database_object_favorites_owner_idx (owner_user_id, updated_at),
  CONSTRAINT database_object_favorites_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_object_favorites_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_connection_preferences (
  owner_user_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  starred TINYINT NOT NULL DEFAULT 0,
  color VARCHAR(32) NOT NULL DEFAULT '',
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (owner_user_id, connection_id),
  CONSTRAINT database_connection_preferences_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_connection_preferences_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ssh_command_favorites (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  command_text LONGTEXT NOT NULL,
  command_hash CHAR(64) NOT NULL,
  cwd TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ssh_command_favorites_unique_idx (owner_user_id, connection_id, command_hash),
  KEY ssh_command_favorites_connection_idx (owner_user_id, connection_id, updated_at),
  CONSTRAINT ssh_command_favorites_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT ssh_command_favorites_connection_fk FOREIGN KEY (connection_id) REFERENCES ssh_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connection_inspection_results (
  connection_type VARCHAR(16) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  latency_ms BIGINT NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  checked_by_user_id VARCHAR(64) NULL,
  checked_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (connection_type, connection_id),
  KEY connection_inspection_results_checked_idx (checked_at),
  CONSTRAINT connection_inspection_results_user_fk FOREIGN KEY (checked_by_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connection_import_batches (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL DEFAULT 'personal',
  workspace_id VARCHAR(64) NOT NULL DEFAULT '',
  source_id VARCHAR(64) NOT NULL,
  type VARCHAR(16) NOT NULL,
  filename VARCHAR(512) NOT NULL,
  status VARCHAR(16) NOT NULL,
  summary_json LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  completed_at VARCHAR(32) NULL,
  CONSTRAINT connection_import_batches_source_fk FOREIGN KEY (source_id) REFERENCES connection_sources(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS connection_import_items (
  id VARCHAR(64) PRIMARY KEY,
  batch_id VARCHAR(64) NOT NULL,
  connection_type VARCHAR(16) NOT NULL,
  source_path TEXT NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  endpoint VARCHAR(1024) NOT NULL,
  payload_ciphertext LONGTEXT NOT NULL,
  status VARCHAR(16) NOT NULL,
  conflict_json LONGTEXT NOT NULL,
  warnings_json LONGTEXT NOT NULL,
  created_connection_id VARCHAR(64) NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY connection_import_items_batch_idx (batch_id, status),
  CONSTRAINT connection_import_items_batch_fk FOREIGN KEY (batch_id) REFERENCES connection_import_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS database_tasks (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NULL,
  type VARCHAR(16) NOT NULL,
  connection_id VARCHAR(64) NULL,
  status VARCHAR(16) NOT NULL,
  progress INT NOT NULL DEFAULT 0,
  title VARCHAR(512) NOT NULL,
  details_json LONGTEXT NOT NULL,
  logs_json LONGTEXT NOT NULL,
  output_path TEXT NULL,
  error_message TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  started_at VARCHAR(32) NULL,
  completed_at VARCHAR(32) NULL,
  KEY database_tasks_created_idx (created_at),
  CONSTRAINT database_tasks_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT database_tasks_connection_fk FOREIGN KEY (connection_id) REFERENCES database_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ssh_terminal_recordings (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id VARCHAR(64) NULL,
  session_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NULL,
  connection_name VARCHAR(255) NOT NULL,
  host VARCHAR(255) NOT NULL,
  recording_path TEXT NOT NULL,
  status VARCHAR(16) NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  started_at VARCHAR(32) NOT NULL,
  ended_at VARCHAR(32) NULL,
  close_reason TEXT NOT NULL,
  UNIQUE KEY ssh_terminal_recordings_session_idx (session_id),
  KEY ssh_terminal_recordings_started_idx (started_at),
  CONSTRAINT ssh_terminal_recordings_owner_fk FOREIGN KEY (owner_user_id) REFERENCES admin_users(id) ON DELETE CASCADE,
  CONSTRAINT ssh_terminal_recordings_connection_fk FOREIGN KEY (connection_id) REFERENCES ssh_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(64) PRIMARY KEY,
  actor_user_id VARCHAR(64) NULL,
  workspace_type VARCHAR(20) NULL,
  workspace_id VARCHAR(64) NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'unknown',
  action VARCHAR(128) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(64) NULL,
  summary TEXT NOT NULL,
  details_json LONGTEXT NOT NULL,
  ip_address VARCHAR(128) NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY audit_events_created_idx (created_at),
  CONSTRAINT audit_events_actor_fk FOREIGN KEY (actor_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  \`key\` VARCHAR(128) PRIMARY KEY,
  value_json LONGTEXT NOT NULL,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tls_endpoints (
  id VARCHAR(64) PRIMARY KEY,
  environment_id VARCHAR(64) NOT NULL,
  ssh_connection_id VARCHAR(64) NULL,
  ssh_bind_key VARCHAR(64) NOT NULL DEFAULT '',
  host VARCHAR(253) NOT NULL,
  port INT NOT NULL,
  sni VARCHAR(253) NOT NULL DEFAULT '',
  source VARCHAR(16) NOT NULL,
  observe_enabled TINYINT NOT NULL DEFAULT 1,
  customized TINYINT NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  probe_status VARCHAR(32) NOT NULL DEFAULT 'never',
  probe_error TEXT NOT NULL,
  probed_at VARCHAR(32) NULL,
  leaf_cn VARCHAR(255) NOT NULL DEFAULT '',
  leaf_sans_json LONGTEXT NOT NULL,
  issuer VARCHAR(512) NOT NULL DEFAULT '',
  serial VARCHAR(128) NOT NULL DEFAULT '',
  signature_algorithm VARCHAR(128) NOT NULL DEFAULT '',
  not_before VARCHAR(64) NULL,
  not_after VARCHAR(64) NULL,
  fingerprint_sha256 VARCHAR(128) NOT NULL DEFAULT '',
  is_self_signed TINYINT NOT NULL DEFAULT 0,
  hostname_match TINYINT NULL,
  chain_complete TINYINT NULL,
  days_remaining INT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY tls_endpoints_identity_idx (environment_id, ssh_bind_key, host, port, sni),
  KEY tls_endpoints_environment_idx (environment_id, sort_order, updated_at),
  KEY tls_endpoints_connection_idx (ssh_connection_id, probed_at),
  CONSTRAINT tls_endpoints_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CONSTRAINT tls_endpoints_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tls_endpoint_web_entries (
  endpoint_id VARCHAR(64) NOT NULL,
  web_entry_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (endpoint_id, web_entry_id),
  KEY tls_endpoint_web_entries_entry_idx (web_entry_id),
  CONSTRAINT tls_endpoint_web_entries_endpoint_fk FOREIGN KEY (endpoint_id) REFERENCES tls_endpoints(id) ON DELETE CASCADE,
  CONSTRAINT tls_endpoint_web_entries_entry_fk FOREIGN KEY (web_entry_id) REFERENCES web_entries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(64) PRIMARY KEY,
  checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ssl_certificates (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL,
  fingerprint_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  leaf_cn VARCHAR(255) NOT NULL DEFAULT '',
  leaf_sans_json LONGTEXT NOT NULL,
  issuer VARCHAR(512) NOT NULL DEFAULT '',
  serial VARCHAR(128) NOT NULL DEFAULT '',
  signature_algorithm VARCHAR(128) NOT NULL DEFAULT '',
  not_before VARCHAR(32) NOT NULL,
  not_after VARCHAR(32) NOT NULL,
  is_self_signed TINYINT NOT NULL DEFAULT 0,
  first_seen_at VARCHAR(32) NOT NULL,
  last_seen_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ssl_certificates_workspace_fingerprint_idx (workspace_type, workspace_id, fingerprint_sha256),
  KEY ssl_certificates_workspace_expiry_idx (workspace_type, workspace_id, not_after),
  KEY ssl_certificates_workspace_cn_idx (workspace_type, workspace_id, leaf_cn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ssl_endpoints (
  id VARCHAR(64) PRIMARY KEY,
  environment_id VARCHAR(64) NOT NULL,
  certificate_id VARCHAR(64) NULL,
  ssh_connection_id VARCHAR(64) NULL,
  ssh_bind_key VARCHAR(64) NOT NULL DEFAULT '',
  host VARCHAR(253) NOT NULL,
  port INT NOT NULL,
  sni VARCHAR(253) NOT NULL DEFAULT '',
  source VARCHAR(16) NOT NULL,
  observe_enabled TINYINT NOT NULL DEFAULT 1,
  customized TINYINT NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  probe_status VARCHAR(32) NOT NULL DEFAULT 'never',
  probe_error TEXT NOT NULL,
  probed_at VARCHAR(32) NULL,
  last_success_at VARCHAR(32) NULL,
  hostname_match TINYINT NULL,
  chain_complete TINYINT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY ssl_endpoints_identity_idx (environment_id, ssh_bind_key, host, port, sni),
  KEY ssl_endpoints_environment_idx (environment_id, sort_order, updated_at),
  KEY ssl_endpoints_connection_idx (ssh_connection_id, probed_at),
  KEY ssl_endpoints_certificate_idx (certificate_id),
  CONSTRAINT ssl_endpoints_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CONSTRAINT ssl_endpoints_certificate_fk FOREIGN KEY (certificate_id) REFERENCES ssl_certificates(id) ON DELETE SET NULL,
  CONSTRAINT ssl_endpoints_connection_fk FOREIGN KEY (ssh_connection_id) REFERENCES ssh_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ssl_endpoint_web_entries (
  endpoint_id VARCHAR(64) NOT NULL,
  web_entry_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (endpoint_id, web_entry_id),
  UNIQUE KEY ssl_endpoint_web_entries_entry_uidx (web_entry_id),
  CONSTRAINT ssl_endpoint_web_entries_endpoint_fk FOREIGN KEY (endpoint_id) REFERENCES ssl_endpoints(id) ON DELETE CASCADE,
  CONSTRAINT ssl_endpoint_web_entries_entry_fk FOREIGN KEY (web_entry_id) REFERENCES web_entries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_operation_runs (
  id VARCHAR(64) PRIMARY KEY,
  workspace_type VARCHAR(20) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL,
  environment_id VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  requested_by_user_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  progress_json LONGTEXT NOT NULL,
  result_json LONGTEXT NOT NULL,
  error_code VARCHAR(64) NOT NULL DEFAULT '',
  created_at VARCHAR(32) NOT NULL,
  started_at VARCHAR(32) NULL,
  completed_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY service_operation_runs_idempotency_idx (workspace_type, workspace_id, idempotency_key),
  KEY service_operation_runs_environment_idx (environment_id, created_at),
  CONSTRAINT service_operation_runs_environment_fk FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CONSTRAINT service_operation_runs_user_fk FOREIGN KEY (requested_by_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_operation_locks (
  workspace_type VARCHAR(20) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL,
  resource_key VARCHAR(160) NOT NULL,
  operation_id VARCHAR(64) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (workspace_type, workspace_id, resource_key),
  CONSTRAINT service_operation_locks_operation_fk FOREIGN KEY (operation_id) REFERENCES service_operation_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`
