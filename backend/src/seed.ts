import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import type { ItemType, ProjectRole, WorkflowTemplate } from '@nops/shared';
import { sql, type Tx } from './db';
import { seedProjectStructure } from './services/projects';

/**
 * Deterministic demo data (docs/03-data-model.md §3.4). Runs only when the database is empty.
 * Password for every demo user: Demo@1234
 */

// Small deterministic PRNG so every reviewer sees the same data.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261017);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;

const USERS = [
  { key: 'neha', name: 'Neha Kapoor', title: 'IT Administrator', dept: 'IT', admin: true, color: '#0f766e' },
  { key: 'anita', name: 'Anita Verma', title: 'Finance Manager', dept: 'Finance', color: '#7c3aed' },
  { key: 'ravi', name: 'Ravi Sharma', title: 'Senior Finance Analyst', dept: 'Finance', color: '#2563eb' },
  { key: 'meera', name: 'Meera Pillai', title: 'Finance Analyst', dept: 'Finance', color: '#db2777' },
  { key: 'arjun', name: 'Arjun Mehta', title: 'Engineering Manager', dept: 'Engineering', color: '#ea580c' },
  { key: 'kabir', name: 'Kabir Singh', title: 'SRE Lead', dept: 'Engineering', color: '#16a34a' },
  { key: 'priya', name: 'Priya Nair', title: 'Backend Engineer', dept: 'Engineering', color: '#0891b2' },
  { key: 'sameer', name: 'Sameer Khan', title: 'Customer Success Manager', dept: 'Customer Success', color: '#b45309' },
  { key: 'divya', name: 'Divya Rao', title: 'Support Lead', dept: 'Customer Success', color: '#4f46e5' },
  { key: 'rohan', name: 'Rohan Das', title: 'Support Agent', dept: 'Customer Success', color: '#be123c' },
  { key: 'isha', name: 'Isha Gupta', title: 'Compliance Manager', dept: 'Security & Compliance', color: '#9333ea' },
  { key: 'vikram', name: 'Vikram Joshi', title: 'Security Lead', dept: 'Security & Compliance', color: '#0369a1' },
  { key: 'tara', name: 'Tara Bose', title: 'Marketing Executive', dept: 'Marketing', color: '#65a30d' },
] as const;

type UserKey = (typeof USERS)[number]['key'];

const PROJECTS: {
  key: string;
  name: string;
  team: string;
  template: WorkflowTemplate;
  goal: string;
  status: string;
  health: 'on_track' | 'at_risk' | 'off_track';
  count: number;
  types: ItemType[];
  members: [UserKey, ProjectRole][];
}[] = [
  {
    key: 'PAY',
    name: 'Vendor Payments',
    team: 'Finance',
    template: 'approval',
    goal: 'Clear Q4 vendor payment exceptions before the 31 Dec audit',
    status: 'Waiting on the bank for three reversals',
    health: 'at_risk',
    count: 6000,
    types: ['payment', 'payment', 'payment', 'task', 'customer_issue'],
    members: [['anita', 'manager'], ['ravi', 'lead'], ['meera', 'member']],
  },
  {
    key: 'INC',
    name: 'Production Incidents',
    team: 'Platform',
    template: 'incident',
    goal: 'Keep checkout and login above 99.9% availability',
    status: 'Two P2 incidents under investigation',
    health: 'on_track',
    count: 6000,
    types: ['incident', 'incident', 'incident', 'task'],
    members: [['arjun', 'manager'], ['kabir', 'lead'], ['priya', 'member'], ['vikram', 'member']],
  },
  {
    key: 'CUS',
    name: 'Customer Escalations',
    team: 'Customer Success',
    template: 'standard',
    goal: 'Resolve enterprise escalations within 3 business days',
    status: 'Backlog trending down this week',
    health: 'on_track',
    count: 6000,
    types: ['customer_issue', 'customer_issue', 'task', 'payment'],
    members: [['sameer', 'manager'], ['divya', 'lead'], ['rohan', 'member'], ['priya', 'member']],
  },
  {
    key: 'SOC',
    name: 'SOC2 Evidence',
    team: 'Security & Compliance',
    template: 'approval',
    goal: 'Collect and approve all SOC2 Type II evidence by 15 Nov',
    status: 'Access review evidence overdue',
    health: 'off_track',
    count: 2000,
    types: ['compliance', 'compliance', 'task'],
    members: [['isha', 'manager'], ['vikram', 'lead'], ['ravi', 'member']],
  },
];

const VENDORS = ['ACME Corp', 'Globex', 'Initech', 'Umbrella Supplies', 'Stark Logistics', 'Wayne Freight', 'Hooli Cloud', 'Vandelay Imports'];
const SERVICES = ['checkout-api', 'auth-service', 'search', 'payments-gateway', 'notifications', 'billing-worker', 'cdn-edge'];
const REGIONS = ['ap-south-1', 'eu-west-1', 'us-east-1'];
const CUSTOMERS = ['Northwind', 'Contoso', 'Fabrikam', 'Tailspin Toys', 'Litware', 'Adatum', 'Proseware'];
const SYSTEMS = ['production AWS', 'GitHub', 'Okta', 'payroll', 'the data warehouse', 'HR system'];
const POLICIES = ['access control', 'incident response', 'change management', 'vendor management', 'data retention'];
const MONTHS = ['July', 'August', 'September', 'October'];

function makeTitle(project: string, n: number): { title: string; description: string } {
  switch (project) {
    case 'PAY': {
      const v = pick(VENDORS);
      const inv = `INV-${2000 + (n % 7000)}`;
      return pick([
        { title: `${v} charged twice for invoice ${inv}`, description: `Bank statement shows two debits for ${inv}. Confirm with the bank and request a reversal of the duplicate.` },
        { title: `Refund of $${(1 + (n % 40)) * 300} pending for ${v}`, description: `Vendor confirmed the refund. It needs approval before finance releases it.` },
        { title: `Payment to ${v} returned by bank`, description: `Wire was returned with reason "account closed". Get updated bank details from the vendor.` },
        { title: `Reconcile ${pick(MONTHS)} statement for ${v}`, description: `Statement total does not match the ledger. Find the missing entries.` },
        { title: `Wire to ${v} stuck in compliance hold`, description: `Sanctions screening flagged the beneficiary name. Provide documents to the bank.` },
      ]);
    }
    case 'INC': {
      const svc = pick(SERVICES);
      return pick([
        { title: `${svc} 5xx spike in ${pick(REGIONS)}`, description: `Error rate above 2% for 10 minutes. Customers see failed requests.` },
        { title: `Latency regression on ${svc}`, description: `p95 latency doubled after the last deploy.` },
        { title: `${svc} queue backlog growing`, description: `Consumers are falling behind; backlog above 50k messages.` },
        { title: `TLS certificate expiring for ${svc}`, description: `Certificate expires in 7 days and auto-renewal failed.` },
        { title: `Disk at 90% on ${svc} database`, description: `Storage grows faster than forecast; risk of write failures.` },
      ]);
    }
    case 'CUS': {
      const c = pick(CUSTOMERS);
      return pick([
        { title: `${c} cannot export monthly reports`, description: `Export times out for accounts with more than 10k rows.` },
        { title: `${c} billing dispute for ${pick(MONTHS)}`, description: `Customer says they were billed for seats they removed.` },
        { title: `${c} requests SSO setup help`, description: `Their IT team is stuck on the SAML configuration.` },
        { title: `${c} data sync delayed by 6 hours`, description: `Nightly sync finished late twice this week.` },
        { title: `Escalation: ${c} renewal at risk`, description: `Executive sponsor raised unresolved tickets during the renewal call.` },
      ]);
    }
    default: {
      return pick([
        { title: `Collect access review evidence for ${pick(SYSTEMS)}`, description: `Export the quarterly access review with reviewer sign-off.` },
        { title: `Policy sign-off: ${pick(POLICIES)}`, description: `Policy owner must review and approve the updated policy.` },
        { title: `Vendor risk assessment for ${pick(VENDORS)}`, description: `Collect the vendor's SOC2 report and complete the questionnaire.` },
        { title: `Backup restore test evidence for ${pick(SYSTEMS)}`, description: `Run a restore test and attach screenshots of the result.` },
      ]);
    }
  }
}

const DAY = 86_400_000;

export async function seed() {
  const [existing] = await sql`select 1 from organizations limit 1`;
  if (existing) {
    console.log('seed skipped: database already has data');
    return;
  }
  const started = Date.now();
  const passwordHash = await bcrypt.hash('Demo@1234', 10);
  const now = Date.now();

  await sql.begin(async (tx) => {
    const [{ id: orgId }] = await tx<{ id: string }[]>`insert into organizations (name) values ('Newtonite') returning id`;

    const userIds = new Map<UserKey, string>();
    for (const [i, u] of USERS.entries()) {
      const id = randomUUID();
      userIds.set(u.key, id);
      await tx`
        insert into users (id, org_id, email, password_hash, full_name, designation, department, employee_code, avatar_color, is_admin, created_at)
        values (${id}, ${orgId}, ${u.key + '@newtonite.test'}, ${passwordHash}, ${u.name}, ${u.title}, ${u.dept},
                ${'EMP-' + String(101 + i).padStart(4, '0')}, ${u.color}, ${'admin' in u ? u.admin : false},
                ${new Date(now - 280 * DAY)})`;
    }
    const admin = userIds.get('neha')!;

    const teamIds = new Map<string, string>();
    for (const t of [...new Set(PROJECTS.map((p) => p.team))]) {
      const [{ id }] = await tx<{ id: string }[]>`insert into teams (org_id, name) values (${orgId}, ${t}) returning id`;
      teamIds.set(t, id);
    }

    const allEvents: Record<string, unknown>[] = [];
    for (const p of PROJECTS) {
      await seedProject(tx, orgId, admin, teamIds.get(p.team)!, p, userIds, allEvents);
    }
    // Insert history in time order so event ids follow time, exactly as live events do.
    allEvents.sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime());
    for (const e of allEvents) e.data = tx.json(e.data as any);
    for (let i = 0; i < allEvents.length; i += 2000) await tx`insert into activity_events ${tx(allEvents.slice(i, i + 2000))}`;
  });

  // Profile stats for the seeded history (live events are counted by the worker).
  await sql`
    insert into user_project_stats (user_id, project_id, claimed, resolved, approved, notes)
    select actor_id, project_id,
      count(*) filter (where type = 'item.claimed'),
      count(*) filter (where type in ('item.transitioned', 'item.approved') and data->'to'->>'kind' = 'done'),
      count(*) filter (where type = 'item.approved'),
      count(*) filter (where type = 'note.added')
    from activity_events where actor_id is not null and item_id is not null
    group by actor_id, project_id`;
  await sql`analyze`;
  const [{ items }] = await sql`select count(*)::int as items from work_items`;
  const [{ events }] = await sql`select count(*)::int as events from activity_events`;
  console.log(`seeded ${items} items and ${events} activity events in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function seedProject(
  tx: Tx,
  orgId: string,
  adminId: string,
  teamId: string,
  p: (typeof PROJECTS)[number],
  userIds: Map<UserKey, string>,
  allEvents: Record<string, unknown>[],
) {
  const now = Date.now();
  const projectId = randomUUID();
  const manager = userIds.get(p.members.find(([, r]) => r === 'manager')![0])!;
  await tx`
    insert into projects (id, org_id, team_id, key, name, goal, status_note, health, created_by, updated_by, created_at)
    values (${projectId}, ${orgId}, ${teamId}, ${p.key}, ${p.name}, ${p.goal}, ${p.status}, ${p.health},
            ${adminId}, ${manager}, ${new Date(now - 200 * DAY)})`;
  await seedProjectStructure(tx, projectId, adminId, p.template);

  // Memberships. Ravi was a Member of PAY before being promoted to Lead (role history demo).
  for (const [key, role] of p.members) {
    const userId = userIds.get(key)!;
    if (p.key === 'PAY' && key === 'ravi') {
      await tx`
        insert into project_members (project_id, user_id, role, valid_from, valid_to, added_by, reason)
        values (${projectId}, ${userId}, 'member', ${new Date(now - 200 * DAY)}, ${new Date(now - 60 * DAY)}, ${adminId}, 'Joined the payments team')`;
      await tx`
        insert into project_members (project_id, user_id, role, valid_from, added_by, reason)
        values (${projectId}, ${userId}, 'lead', ${new Date(now - 60 * DAY)}, ${manager}, 'Promoted to Lead')`;
      continue;
    }
    await tx`
      insert into project_members (project_id, user_id, role, valid_from, added_by, reason)
      values (${projectId}, ${userId}, ${role}, ${new Date(now - 200 * DAY)}, ${adminId}, 'Founding member')`;
  }

  const stages = await tx<{ id: string; name: string; kind: string; requires_approval: boolean; sort_order: number }[]>`
    select id, name, kind, requires_approval, sort_order from workflow_stages where project_id = ${projectId} order by sort_order`;
  const memberIds = p.members.map(([k]) => userIds.get(k)!);
  // The role each person held at a given moment (history records the role at the time).
  const roles = new Map(p.members.map(([k, r]) => [userIds.get(k)!, r]));
  const promotedAt = now - 60 * DAY;
  const roleAt = (userId: string, at: Date): ProjectRole =>
    p.key === 'PAY' && userId === userIds.get('ravi') && at.getTime() < promotedAt ? 'member' : roles.get(userId)!;
  // Weighted stage distribution: most history is finished work.
  const weights = stages.map((s) => (s.kind === 'done' ? (s.name === 'Closed' ? 10 : 3) : s.kind === 'start' ? 2 : 1.5));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const pickStage = () => {
    let r = rand() * totalWeight;
    for (const [i, w] of weights.entries()) if ((r -= w) <= 0) return stages[i];
    return stages[0];
  };

  const items: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  for (let n = 1; n <= p.count; n++) {
    const id = randomUUID();
    const stage = pickStage();
    const createdAt = new Date(now - rand() * 180 * DAY);
    const creator = pick(memberIds);
    const isOpen = stage.kind !== 'done';
    const assignee = stage.kind === 'start' && chance(0.6) ? null : pick(memberIds);
    const { title, description } = makeTitle(p.key, n);
    const priority = chance(0.08) ? 1 : chance(0.25) ? 2 : chance(0.6) ? 3 : 4;
    // Recent open items stay "fresh"; a slice is deliberately stale for the Forgotten view.
    const lastActivity = isOpen && chance(0.85)
      ? new Date(Math.max(createdAt.getTime(), now - rand() * 4 * DAY))
      : new Date(createdAt.getTime() + rand() * (now - createdAt.getTime()));
    const dueAt = isOpen && chance(0.5) ? new Date(now + (rand() * 20 - 4) * DAY) : null;
    const nextAction = isOpen && assignee && chance(0.4) ? pick(['Confirm with the bank', 'Call the customer back', 'Check the logs from last deploy', 'Get sign-off from the policy owner', 'Ask vendor for documents']) : null;

    let version = 1;
    const claimedAt = new Date(createdAt.getTime() + 3_600_000);
    events.push({ project_id: projectId, item_id: id, actor_id: creator, actor_role: roleAt(creator, createdAt), type: 'item.created', data: { title, priority }, item_version: 1, created_at: createdAt });
    if (assignee) {
      version++;
      events.push({ project_id: projectId, item_id: id, actor_id: assignee, actor_role: roleAt(assignee, claimedAt), type: 'item.claimed', data: { to: assignee }, item_version: version, created_at: claimedAt });
    }
    if (stage.kind !== 'start') {
      version++;
      // Approvals are made by someone who was a Lead/Manager at that time and is not the creator/assignee.
      let actor = assignee ?? creator;
      if (stage.requires_approval) {
        const eligible = memberIds.filter((u) => u !== assignee && u !== creator && roleAt(u, lastActivity) !== 'member');
        actor = eligible.length ? pick(eligible) : manager;
      }
      const from = stages.find((s) => s.sort_order === Math.max(0, stage.sort_order - 1))!;
      events.push({
        project_id: projectId,
        item_id: id,
        actor_id: actor,
        actor_role: roleAt(actor, lastActivity),
        type: stage.requires_approval ? 'item.approved' : 'item.transitioned',
        data: { from: { id: from.id, name: from.name }, to: { id: stage.id, name: stage.name, kind: stage.kind } },
        item_version: version,
        created_at: lastActivity,
      });
    }
    if (chance(0.15)) {
      events.push({
        project_id: projectId,
        item_id: id,
        actor_id: assignee ?? creator,
        actor_role: roleAt(assignee ?? creator, lastActivity),
        type: 'note.added',
        data: { kind: pick(['note', 'decision', 'handoff', 'blocker']), body: pick(['Spoke to the vendor, waiting on documents.', 'Decided to batch these reversals together.', 'Handing over while I am on leave.', 'Blocked until the bank responds.']) },
        item_version: version,
        created_at: lastActivity,
      });
    }
    items.push({
      id,
      project_id: projectId,
      number: n,
      type: pick(p.types),
      title,
      description,
      priority,
      stage_id: stage.id,
      assignee_id: assignee,
      created_by: creator,
      due_at: dueAt,
      next_action: nextAction,
      next_action_due_at: nextAction ? new Date(now + (rand() * 3 - 1) * DAY) : null,
      version,
      last_activity_at: lastActivity,
      created_at: createdAt,
      updated_at: lastActivity,
      deleted_at: null,
      deleted_by: null,
      delete_reason: null,
    });
  }
  // A few deleted items for the Manager's "Deleted items" view.
  for (const item of items.slice(10, 15)) {
    const at = new Date(now - 2 * DAY);
    item.deleted_at = at;
    item.deleted_by = manager;
    item.delete_reason = 'Duplicate of another item';
    item.version = (item.version as number) + 1;
    item.updated_at = at;
    events.push({
      project_id: projectId,
      item_id: item.id,
      actor_id: manager,
      actor_role: 'manager',
      type: 'item.deleted',
      data: { reason: 'Duplicate of another item', key: `${p.key}-${item.number}`, title: item.title },
      item_version: item.version,
      created_at: at,
    });
  }

  for (let i = 0; i < items.length; i += 1000) await tx`insert into work_items ${tx(items.slice(i, i + 1000))}`;
  allEvents.push(...events);
  await tx`update projects set next_item_number = ${p.count + 1} where id = ${projectId}`;

  // Some open items are blocked by other open items.
  const open = items.filter((it) => stages.find((s) => s.id === it.stage_id)?.kind !== 'done' && !it.deleted_at);
  const links: Record<string, unknown>[] = [];
  for (let i = 0; i + 1 < Math.min(open.length, 80); i += 2) {
    links.push({ project_id: projectId, blocker_item_id: open[i].id, blocked_item_id: open[i + 1].id, created_by: manager });
  }
  if (links.length) await tx`insert into item_links ${tx(links)}`;

  // A few drawing elements so the canvas doesn't start empty.
  await tx`
    insert into canvas_elements (id, project_id, type, x, y, width, height, props, created_by, updated_by)
    values (${randomUUID()}, ${projectId}, 'sticky', 600, 60, 260, 160,
            ${tx.json({ text: 'Reminder: check the board before standup', color: 'yellow' })}, ${manager}, ${manager})`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  seed()
    .then(() => sql.end())
    .catch(async (err) => {
      console.error(err);
      await sql.end();
      process.exit(1);
    });
}
