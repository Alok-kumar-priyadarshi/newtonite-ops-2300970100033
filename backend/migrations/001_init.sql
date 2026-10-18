-- Newtonite Ops schema. See docs/03-data-model.md.
-- Timestamps use millisecond precision (timestamptz(3)) so values round-trip exactly through
-- JavaScript Dates; this matters for keyset pagination cursors.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE project_role   AS ENUM ('manager', 'lead', 'member');
CREATE TYPE project_health AS ENUM ('on_track', 'at_risk', 'off_track', 'done');
CREATE TYPE item_type      AS ENUM ('incident', 'customer_issue', 'payment', 'compliance', 'task');
CREATE TYPE stage_kind     AS ENUM ('start', 'active', 'done');
CREATE TYPE canvas_element_type AS ENUM
  ('project_node', 'stage_frame', 'rectangle', 'ellipse', 'diamond', 'text', 'sticky', 'arrow', 'freehand');
CREATE TYPE outbox_status  AS ENUM ('pending', 'processing', 'done', 'failed');

-- ---------------------------------------------------------------- identity
CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  email         text NOT NULL,
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  designation   text NOT NULL DEFAULT '',
  department    text NOT NULL DEFAULT '',
  employee_code text NOT NULL,
  avatar_color  text NOT NULL DEFAULT '#64748b',
  is_admin      boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz(3) NOT NULL DEFAULT now(),
  updated_at    timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_employee_code_uq ON users (org_id, employee_code);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id),
  name       text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_name_uq ON teams (org_id, lower(name));

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  team_id          uuid NOT NULL REFERENCES teams(id),
  key              varchar(5) NOT NULL CHECK (key ~ '^[A-Z]{2,5}$'),
  name             text NOT NULL,
  goal             text NOT NULL DEFAULT '',
  status_note      text NOT NULL DEFAULT '',
  health           project_health NOT NULL DEFAULT 'on_track',
  next_item_number integer NOT NULL DEFAULT 1,
  version          integer NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL REFERENCES users(id),
  updated_by       uuid REFERENCES users(id),
  created_at       timestamptz(3) NOT NULL DEFAULT now(),
  updated_at       timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_key_uq ON projects (org_id, key);

CREATE TABLE project_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  role       project_role NOT NULL,
  valid_from timestamptz(3) NOT NULL DEFAULT now(),
  valid_to   timestamptz(3),
  added_by   uuid REFERENCES users(id),
  reason     text,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
-- One current role per person per project, and exactly one current Manager per project.
CREATE UNIQUE INDEX project_members_current_uq ON project_members (project_id, user_id) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX project_members_one_manager_uq ON project_members (project_id) WHERE role = 'manager' AND valid_to IS NULL;
CREATE INDEX project_members_user_current_idx ON project_members (user_id) WHERE valid_to IS NULL;
CREATE INDEX project_members_user_history_idx ON project_members (user_id, valid_from DESC);

-- ---------------------------------------------------------------- workflow
CREATE TABLE workflows (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  version    integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE workflow_stages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id),
  name              text NOT NULL,
  kind              stage_kind NOT NULL DEFAULT 'active',
  requires_approval boolean NOT NULL DEFAULT false,
  sort_order        integer NOT NULL DEFAULT 0,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz(3) NOT NULL DEFAULT now(),
  updated_at        timestamptz(3) NOT NULL DEFAULT now(),
  deleted_at        timestamptz(3)
);
CREATE UNIQUE INDEX workflow_stages_name_uq ON workflow_stages (project_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX workflow_stages_one_start_uq ON workflow_stages (project_id) WHERE kind = 'start' AND deleted_at IS NULL;
CREATE INDEX workflow_stages_project_idx ON workflow_stages (project_id) WHERE deleted_at IS NULL;

CREATE TABLE workflow_transitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  from_stage_id   uuid NOT NULL REFERENCES workflow_stages(id),
  to_stage_id     uuid NOT NULL REFERENCES workflow_stages(id),
  label           text,
  requires_reason boolean NOT NULL DEFAULT false,
  lead_only       boolean NOT NULL DEFAULT false,
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  updated_at      timestamptz(3) NOT NULL DEFAULT now(),
  deleted_at      timestamptz(3),
  CHECK (from_stage_id <> to_stage_id)
);
CREATE UNIQUE INDEX workflow_transitions_pair_uq ON workflow_transitions (from_stage_id, to_stage_id) WHERE deleted_at IS NULL;
CREATE INDEX workflow_transitions_project_idx ON workflow_transitions (project_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- work items
CREATE TABLE work_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id),
  number             integer NOT NULL,
  type               item_type NOT NULL,
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description        text NOT NULL DEFAULT '' CHECK (char_length(description) <= 10000),
  priority           smallint NOT NULL CHECK (priority BETWEEN 1 AND 4),
  stage_id           uuid NOT NULL REFERENCES workflow_stages(id),
  assignee_id        uuid REFERENCES users(id),
  created_by         uuid NOT NULL REFERENCES users(id),
  due_at             timestamptz(3),
  next_action        text,
  next_action_due_at timestamptz(3),
  version            integer NOT NULL DEFAULT 1,
  last_activity_at   timestamptz(3) NOT NULL DEFAULT now(),
  created_at         timestamptz(3) NOT NULL DEFAULT now(),
  updated_at         timestamptz(3) NOT NULL DEFAULT now(),
  deleted_at         timestamptz(3),
  deleted_by         uuid REFERENCES users(id),
  delete_reason      text,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);
CREATE UNIQUE INDEX work_items_number_uq ON work_items (project_id, number);
CREATE INDEX work_items_stage_idx      ON work_items (project_id, stage_id, priority, due_at, id) WHERE deleted_at IS NULL;
CREATE INDEX work_items_updated_idx    ON work_items (project_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX work_items_changes_idx    ON work_items (project_id, updated_at);
CREATE INDEX work_items_assignee_idx   ON work_items (assignee_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX work_items_unassigned_idx ON work_items (project_id, priority, created_at) WHERE assignee_id IS NULL AND deleted_at IS NULL;
CREATE INDEX work_items_activity_idx   ON work_items (project_id, last_activity_at) WHERE deleted_at IS NULL;
CREATE INDEX work_items_due_idx        ON work_items (project_id, due_at) WHERE deleted_at IS NULL;
CREATE INDEX work_items_next_action_idx ON work_items (assignee_id, next_action_due_at) WHERE next_action IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX work_items_deleted_idx    ON work_items (project_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX work_items_search_idx     ON work_items USING gin (search);

CREATE TABLE item_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  blocker_item_id uuid NOT NULL REFERENCES work_items(id),
  blocked_item_id uuid NOT NULL REFERENCES work_items(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (blocker_item_id <> blocked_item_id)
);
CREATE UNIQUE INDEX item_links_pair_uq ON item_links (blocker_item_id, blocked_item_id);
CREATE INDEX item_links_blocked_idx ON item_links (blocked_item_id);

-- ---------------------------------------------------------------- history (append-only)
CREATE TABLE activity_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects(id),
  item_id      uuid REFERENCES work_items(id),
  actor_id     uuid REFERENCES users(id),
  actor_role   text NOT NULL,
  type         text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  item_version integer,
  created_at   timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX activity_item_idx    ON activity_events (item_id, id DESC);
CREATE INDEX activity_project_idx ON activity_events (project_id, id DESC);
CREATE INDEX activity_actor_idx   ON activity_events (actor_id, id DESC);

CREATE FUNCTION activity_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only (% blocked)', TG_OP;
END;
$$;
CREATE TRIGGER activity_events_no_update BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION activity_events_immutable();

-- ---------------------------------------------------------------- canvas
CREATE TABLE canvas_elements (
  id         uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  type       canvas_element_type NOT NULL,
  stage_id   uuid REFERENCES workflow_stages(id),
  x          double precision NOT NULL,
  y          double precision NOT NULL,
  width      double precision NOT NULL,
  height     double precision NOT NULL,
  z_index    integer NOT NULL DEFAULT 0,
  props      jsonb NOT NULL DEFAULT '{}'::jsonb,
  version    integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  deleted_at timestamptz(3),
  deleted_by uuid REFERENCES users(id),
  CHECK ((type = 'stage_frame') = (stage_id IS NOT NULL))
);
CREATE INDEX canvas_elements_project_idx ON canvas_elements (project_id) WHERE deleted_at IS NULL;
CREATE INDEX canvas_elements_changes_idx ON canvas_elements (project_id, updated_at);
CREATE UNIQUE INDEX canvas_elements_stage_uq ON canvas_elements (stage_id) WHERE stage_id IS NOT NULL;
CREATE UNIQUE INDEX canvas_elements_project_node_uq ON canvas_elements (project_id) WHERE type = 'project_node';

-- ---------------------------------------------------------------- async work
CREATE TABLE outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  status          outbox_status NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
  locked_until    timestamptz(3),
  last_error      text,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  processed_at    timestamptz(3)
);
CREATE INDEX outbox_due_idx ON outbox (status, next_attempt_at, id);

CREATE TABLE notifications (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id    uuid NOT NULL REFERENCES users(id),
  project_id      uuid NOT NULL REFERENCES projects(id),
  item_id         uuid REFERENCES work_items(id),
  actor_id        uuid REFERENCES users(id),
  type            text NOT NULL,
  title           text NOT NULL,
  source_event_id bigint REFERENCES activity_events(id),
  digest_key      text,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  read_at         timestamptz(3)
);
CREATE UNIQUE INDEX notifications_event_uq  ON notifications (recipient_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX notifications_digest_uq ON notifications (recipient_id, digest_key) WHERE digest_key IS NOT NULL;
CREATE INDEX notifications_inbox_idx  ON notifications (recipient_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;

CREATE TABLE notification_sources (
  notification_id bigint NOT NULL REFERENCES notifications(id),
  source_ref      text NOT NULL,
  PRIMARY KEY (notification_id, source_ref)
);

CREATE TABLE user_project_stats (
  user_id    uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  claimed    integer NOT NULL DEFAULT 0,
  resolved   integer NOT NULL DEFAULT 0,
  approved   integer NOT NULL DEFAULT 0,
  notes      integer NOT NULL DEFAULT 0,
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE processed_stat_events (
  event_id bigint PRIMARY KEY
);

-- ---------------------------------------------------------------- request safety & presence
CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL REFERENCES users(id),
  key             text NOT NULL,
  method          text NOT NULL,
  path            text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE UNLOGGED TABLE presence (
  user_id              uuid NOT NULL,
  resource_type        text NOT NULL,
  resource_id          uuid NOT NULL,
  project_id           uuid NOT NULL,
  selected_element_ids uuid[] NOT NULL DEFAULT '{}',
  last_seen_at         timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, resource_type, resource_id)
);
CREATE INDEX presence_resource_idx ON presence (resource_type, resource_id, last_seen_at);
