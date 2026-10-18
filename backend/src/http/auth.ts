import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { CSRF_HEADER, CSRF_VALUE, type ProjectRole } from '@nops/shared';
import { config } from '../config';
import { sql } from '../db';
import type { Actor } from '../domain/actor';
import { AppError } from '../domain/errors';

export const SESSION_COOKIE = 'nops_session';
const SESSION_HOURS = 8;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      requestId: string;
    }
  }
}

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: config.cookieSameSite,
  secure: config.secureCookies,
  path: '/',
});

export function issueSession(res: Response, userId: string) {
  const token = jwt.sign({ sub: userId }, config.SESSION_SECRET, { expiresIn: `${SESSION_HOURS}h` });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_HOURS * 3600 * 1000 });
}

export function clearSession(res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/** Loads the user and their *current* roles from the database. The token only says who they are. */
export async function loadActor(userId: string): Promise<Actor | null> {
  const [user] = await sql<{ id: string; org_id: string; full_name: string; is_admin: boolean; is_active: boolean }[]>`
    select id, org_id, full_name, is_admin, is_active from users where id = ${userId}`;
  if (!user || !user.is_active) return null;
  const roles = await sql<{ project_id: string; role: ProjectRole }[]>`
    select project_id, role from project_members where user_id = ${userId} and valid_to is null`;
  return {
    id: user.id,
    orgId: user.org_id,
    fullName: user.full_name,
    isAdmin: user.is_admin,
    roles: new Map(roles.map((r) => [r.project_id, r.role])),
  };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) throw new AppError('UNAUTHENTICATED', 'Please sign in.');
  let userId: string;
  try {
    userId = (jwt.verify(token, config.SESSION_SECRET) as { sub: string }).sub;
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
  }
  const actor = await loadActor(userId);
  if (!actor) throw new AppError('UNAUTHENTICATED', 'Your account is not active.');
  req.actor = actor;
  next();
}

/**
 * CSRF defence: cookies are SameSite=Lax and every state-changing request must carry a custom
 * header, which a cross-site HTML form cannot set.
 */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get(CSRF_HEADER) !== CSRF_VALUE) {
    throw new AppError('CSRF_HEADER_MISSING', `Missing ${CSRF_HEADER} header.`);
  }
  next();
}
