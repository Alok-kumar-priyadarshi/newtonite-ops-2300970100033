import bcrypt from 'bcryptjs';
import { isUniqueViolation, sql, type Tx } from '../db';
import type { Actor } from '../domain/actor';
import { AppError } from '../domain/errors';
import { requireAdmin } from '../domain/permissions';
import { decodeCursor, encodeCursor } from './cursor';

const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#4f46e5', '#b45309'];

export async function listTeams(actor: Actor) {
  return sql<{ id: string; name: string }[]>`select id, name from teams where org_id = ${actor.orgId} order by name`;
}

export async function createTeam(tx: Tx, actor: Actor, input: { name: string }) {
  requireAdmin(actor);
  try {
    const [team] = await tx<{ id: string; name: string }[]>`
      insert into teams (org_id, name) values (${actor.orgId}, ${input.name}) returning id, name`;
    return team;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('KEY_TAKEN', `A team called "${input.name}" already exists.`);
    throw err;
  }
}

export async function listUsers(actor: Actor) {
  requireAdmin(actor);
  return sql`
    select id, email, full_name as "fullName", designation, department, employee_code as "employeeCode",
           is_admin as "isAdmin", is_active as "isActive"
    from users where org_id = ${actor.orgId} order by full_name`;
}

/** Lightweight directory for pickers (any signed-in user). */
export async function directory(actor: Actor) {
  return sql`
    select id, full_name as "fullName", designation from users
    where org_id = ${actor.orgId} and is_active order by full_name`;
}

export async function createUser(
  tx: Tx,
  actor: Actor,
  input: { email: string; fullName: string; designation: string; department: string; employeeCode: string; password: string; isAdmin: boolean },
) {
  requireAdmin(actor);
  const hash = await bcrypt.hash(input.password, 10);
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  try {
    const [u] = await tx`
      insert into users (org_id, email, password_hash, full_name, designation, department, employee_code, avatar_color, is_admin)
      values (${actor.orgId}, ${input.email}, ${hash}, ${input.fullName}, ${input.designation}, ${input.department},
              ${input.employeeCode}, ${color}, ${input.isAdmin})
      returning id, email, full_name as "fullName"`;
    return u;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('KEY_TAKEN', 'That email or employee code is already in use.');
    throw err;
  }
}

export async function setUserActive(tx: Tx, actor: Actor, userId: string, active: boolean) {
  requireAdmin(actor);
  if (userId === actor.id && !active) throw new AppError('VALIDATION_FAILED', 'You cannot deactivate yourself.');
  await tx`update users set is_active = ${active}, updated_at = now() where id = ${userId} and org_id = ${actor.orgId}`;
}

export async function listJobs(actor: Actor, q: { status: string; limit: number; cursor?: string }) {
  requireAdmin(actor);
  const before = decodeCursor(q.cursor) as string | null;
  const rows = await sql<
    { id: string; type: string; status: string; attempts: number; last_error: string | null; created_at: Date; next_attempt_at: Date; payload: unknown }[]
  >`
    select id, type, status, attempts, last_error, created_at, next_attempt_at, payload from outbox
    where status = ${q.status} ${before ? sql`and id < ${before}` : sql``}
    order by id desc limit ${q.limit + 1}`;
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      payload: r.payload,
      createdAt: r.created_at.toISOString(),
      nextAttemptAt: r.next_attempt_at.toISOString(),
    })),
    nextCursor: more ? encodeCursor(page[page.length - 1].id) : null,
  };
}

export async function retryJob(tx: Tx, actor: Actor, jobId: string) {
  requireAdmin(actor);
  await tx`
    update outbox set status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = null
    where id = ${jobId} and status = 'failed'`;
}
